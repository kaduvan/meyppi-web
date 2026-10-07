/* Meyppi free-check engine: a faithful JavaScript port of the Aircheck
   fingerprint pipeline (src/aircheck/fingerprint + matching + forensics +
   classification in the engine repo). Runs in the browser (Web Worker)
   and Node (validation harness). Same parameters, same vote/cluster/
   forensic/classify policy; validated at the outcome level against the
   Python engine's demo-campaign ground truth (scripts/validate-engine.mjs).

   Pipeline: PCM (22.05 kHz mono) -> STFT dB -> spectral peaks ->
   constellation keys -> offset-cluster alignment -> reference-timeline
   forensics (self-normalized) -> delivery classification. */

export const FP_CONFIG = {
  sampleRate: 22050,
  fftSize: 1024,
  hopSize: 256,
  freqMinHz: 100,
  freqMaxHz: 5000,
  peakNeighborhoodFrames: 20,
  peakNeighborhoodBins: 20,
  peakMinDeltaDb: 40,
  targetZoneSpanSec: 1.5,
  fanout: 12,
};

export const MATCH_CONFIG = {
  offsetBinSec: 0.012,
  clusterTolSec: 0.1,
  minAlignedMatches: 10,
  maxOccurrences: 3,
};

export const FORENSIC_CONFIG = {
  coverageBinSec: 0.25,
  maxHoleBins: 1,
  minMatchesPerBin: 1,
};

export const THRESHOLDS = {
  headTolSec: 0.75,
  tailTolSec: 0.75,
  interiorGapTolSec: 0.75,
  coverageRatioFloor: 0.8,
  accusationDensityMin: 0.35,
  minEvidenceMatches: 30,
  reviewCoverageRatioFloor: 0.85,
};

const FRAME_SEC = FP_CONFIG.hopSize / FP_CONFIG.sampleRate;
const MAX_BIN = (1 << 10) - 1;
const MAX_DT = (1 << 9) - 1;

/* ---------- FFT (iterative radix-2, size = fftSize) ------------------- */

function makeFft(n) {
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < Math.log2(n); b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  // twiddles for each stage
  const cos = [], sin = [];
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const c = new Float64Array(half), s = new Float64Array(half);
    for (let j = 0; j < half; j++) {
      c[j] = Math.cos((-2 * Math.PI * j) / len);
      s[j] = Math.sin((-2 * Math.PI * j) / len);
    }
    cos.push(c);
    sin.push(s);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    let stage = 0;
    for (let len = 2; len <= n; len <<= 1, stage++) {
      const half = len >> 1;
      const c = cos[stage], s = sin[stage];
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const k = i + j;
          const tr = re[k + half] * c[j] - im[k + half] * s[j];
          const ti = re[k + half] * s[j] + im[k + half] * c[j];
          re[k + half] = re[k] - tr;
          im[k + half] = im[k] - ti;
          re[k] += tr;
          im[k] += ti;
        }
      }
    }
  };
}

/* ---------- spectral peaks over chunked STFT --------------------------
   Two passes over the PCM so the whole spectrogram is never held in
   memory: pass 1 finds the global max dB (the Python engine thresholds
   every peak relative to it); pass 2 re-runs the STFT per chunk and keeps
   only peaks. Chunk overlap = neighborhood radius so the max filter sees
   the same data it would on the full spectrogram.                        */

const CHUNK_FRAMES = 2048;

function makeWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Max-filter a 1D array with window [i-lo, i+hi] and reflect borders
    (scipy maximum_filter semantics, mode='reflect'). Sliding-deque, O(n).
    Exported for unit testing. */
export function maxFilter1D(src, n, lo, hi, dst) {
  const cap = lo + hi + 2; // live entries never exceed window width + 1
  const dq = new Int32Array(cap);
  let head = 0, tail = 0, count = 0; // circular deque, values decreasing
  const val = (i) => {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * n - 2 - i;
    return src[i];
  };
  for (let i = -lo; i < n + hi; i++) {
    const v = val(i);
    while (count > 0 && val(dq[(tail - 1 + cap) % cap]) <= v) {
      tail = (tail - 1 + cap) % cap;
      count--;
    }
    dq[tail] = i;
    tail = (tail + 1) % cap;
    count++;
    const o = i - hi; // output whose window's right edge is i
    if (o >= 0) {
      if (o >= n) break;
      while (count > 0 && dq[head] < o - lo) {
        head = (head + 1) % cap;
        count--;
      }
      dst[o] = val(dq[head]);
    }
  }
}

/** Peaks of one spectrogram chunk (nFrames x nBins, Float32 rows).
    Mirrors find_spectral_peaks: local max in a 20x20 neighborhood,
    in-band, and >= globalMaxDb - 40. Returns [[frame, bin], ...]. */
function chunkPeaks(rows, nFrames, nBins, globalMaxDb, cfg) {
  const minBin = Math.ceil(cfg.freqMinHz / (cfg.sampleRate / cfg.fftSize));
  const maxBin = Math.floor(cfg.freqMaxHz / (cfg.sampleRate / cfg.fftSize));
  const threshold = globalMaxDb - cfg.peakMinDeltaDb;
  const loF = -(cfg.peakNeighborhoodFrames >> 1);
  const hiF = cfg.peakNeighborhoodFrames - 1 + loF;
  const loB = -(cfg.peakNeighborhoodBins >> 1);
  const hiB = cfg.peakNeighborhoodBins - 1 + loB;

  // max over bins (per frame), then over frames (per bin)
  const rowMax = new Float32Array(nFrames * nBins);
  const tmpOut = new Float32Array(nBins);
  for (let f = 0; f < nFrames; f++) {
    maxFilter1D(rows.subarray(f * nBins, f * nBins + nBins), nBins, -loB, hiB, tmpOut);
    rowMax.set(tmpOut, f * nBins);
  }
  const peaks = [];
  const colIn = new Float32Array(nFrames);
  const colOut = new Float32Array(nFrames);
  const colMax = new Float32Array(nFrames * nBins);
  for (let b = 0; b < nBins; b++) {
    for (let f = 0; f < nFrames; f++) colIn[f] = rowMax[f * nBins + b];
    maxFilter1D(colIn, nFrames, -loF, hiF, colOut);
    for (let f = 0; f < nFrames; f++) colMax[f * nBins + b] = colOut[f];
  }
  for (let f = 0; f < nFrames; f++) {
    const row = rows.subarray(f * nBins, f * nBins + nBins);
    const rmax = colMax.subarray(f * nBins, f * nBins + nBins);
    for (let b = minBin; b <= maxBin; b++) {
      if (row[b] >= rmax[b] && row[b] >= threshold) peaks.push([f, b]);
    }
  }
  return peaks;
}

/** Full pipeline PCM -> peaks (chunked, progress-callback). */
export function findPeaks(pcm, cfg, onProgress) {
  const { fftSize: N, hopSize: hop } = cfg;
  const nBins = N / 2 + 1;
  const nFrames = 1 + Math.floor((pcm.length - N) / hop);
  if (nFrames <= 0) return [];
  const fft = makeFft(N);
  const win = makeWindow(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const specRow = new Float32Array(nBins);

  // pass 1: global max dB
  let globalMaxDb = -Infinity;
  for (let start = 0; start < nFrames; start += CHUNK_FRAMES) {
    const end = Math.min(nFrames, start + CHUNK_FRAMES);
    for (let f = start; f < end; f++) {
      const off = f * hop;
      for (let i = 0; i < N; i++) { re[i] = pcm[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < nBins; b++) {
        const p = re[b] * re[b] + im[b] * im[b];
        const db = 10 * Math.log10(p + 1e-12);
        if (db > globalMaxDb) globalMaxDb = db;
      }
    }
    if (onProgress) onProgress('analyze', (0.45 * end) / nFrames);
  }

  // pass 2: peaks per chunk (with neighborhood overlap, deduped by frame)
  const overlap = cfg.peakNeighborhoodFrames; // generous vs the ±10 window
  const allPeaks = [];
  let done = new Set(); // chunk-local dedup: frames already emitted
  for (let start = 0; start < nFrames; start += CHUNK_FRAMES - overlap) {
    const end = Math.min(nFrames, start + CHUNK_FRAMES);
    const nF = end - start;
    const rows = new Float32Array(nF * nBins);
    for (let f = 0; f < nF; f++) {
      const off = (start + f) * hop;
      for (let i = 0; i < N; i++) { re[i] = pcm[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < nBins; b++) {
        const p = re[b] * re[b] + im[b] * im[b];
        rows[f * nBins + b] = 10 * Math.log10(p + 1e-12);
      }
    }
    for (const [f, b] of chunkPeaks(rows, nF, nBins, globalMaxDb, cfg)) {
      const absFrame = start + f;
      const key = absFrame * 4096 + b;
      if (!done.has(key)) {
        done.add(key);
        allPeaks.push([absFrame, b]);
      }
    }
    if (onProgress) onProgress('analyze', 0.45 + (0.55 * end) / nFrames);
    if (end >= nFrames) break;
  }
  allPeaks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return allPeaks;
}

/* ---------- constellation keys (keys.py) ------------------------------- */

/** Peaks -> {key, tFrame}[] with target-zone pairing and fanout. */
export function fingerprintsFromPeaks(peaks, cfg) {
  const zoneFrames = Math.round(cfg.targetZoneSpanSec / FRAME_SEC);
  const out = [];
  const n = peaks.length;
  if (n < 2) return out;
  // peaks are time-sorted; each anchor pairs with later peaks in the zone
  for (let i = 0; i < n; i++) {
    const t1 = peaks[i][0], f1 = peaks[i][1];
    let paired = 0;
    for (let j = i + 1; j < n && peaks[j][0] <= t1 + zoneFrames; j++) {
      const dt = peaks[j][0] - t1;
      if (dt >= 1 && dt <= MAX_DT && peaks[j][1] <= MAX_BIN && f1 <= MAX_BIN) {
        out.push({
          key: (f1 << 19) | (peaks[j][1] << 9) | dt,
          tSec: t1 * FRAME_SEC,
        });
        paired++;
        if (paired >= cfg.fanout) break;
      }
    }
  }
  return out;
}

/* ---------- reference index + offset-cluster alignment (aligner.py) --- */

export function buildIndex(refPrints) {
  const m = new Map();
  for (const r of refPrints) {
    let arr = m.get(r.key);
    if (!arr) { arr = []; m.set(r.key, arr); }
    arr.push(r.tSec);
  }
  return m;
}

/** Vote + cluster loop, identical policy to align_candidates. */
export function alignCandidates(queryPrints, index, cfg) {
  const clusters = [];
  let remaining = queryPrints;
  const maxClusters = cfg.maxOccurrences;
  while (remaining.length && clusters.length < maxClusters) {
    // vote: (round(offset/bin)) -> matches
    const votes = new Map();
    for (const q of remaining) {
      const refs = index.get(q.key);
      if (!refs) continue;
      for (const refTime of refs) {
        const offset = q.tSec - refTime;
        const bin = Math.round(offset / cfg.offsetBinSec);
        let arr = votes.get(bin);
        if (!arr) { arr = []; votes.set(bin, arr); }
        arr.push({ queryTime: q.tSec, refTime, offset, key: q.key });
      }
    }
    if (!votes.size) break;
    // best bin: most votes, ties by smallest bin index
    let bestBin = -Infinity, bestArr = null;
    for (const [bin, arr] of votes) {
      if (arr.length > (bestArr?.length ?? 0) || (bestArr && arr.length === bestArr.length && bin < bestBin)) {
        bestBin = bin; bestArr = arr;
      }
    }
    if (bestArr.length < cfg.minAlignedMatches) break;
    const modeOffset = modeOffsetOf(bestArr);
    let clusterMatches = bestArr.filter(
      (m) => Math.abs(m.offset - modeOffset) <= cfg.clusterTolSec,
    );
    if (clusterMatches.length < cfg.minAlignedMatches) clusterMatches = bestArr;
    clusters.push({ offsetSec: modeOffset, matches: clusterMatches });
    const consumed = new Set(
      clusterMatches.map((m) => `${m.key}:${m.queryTime.toFixed(6)}`),
    );
    remaining = remaining.filter((r) => !consumed.has(`${r.key}:${r.tSec.toFixed(6)}`));
  }
  clusters.sort((a, b) => b.matches.length - a.matches.length);
  return clusters;
}

function modeOffsetOf(matches) {
  const counts = new Map();
  for (const m of matches) {
    const k = Math.round(m.offset * 1000) / 1000;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = Infinity, bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v < best)) { best = v; bestN = n; }
  }
  return best;
}

/* ---------- forensics (features.py) ------------------------------------ */

function coveredIntervals(refTimes, refDurationSec, cfg) {
  if (!refTimes.length) return [];
  const binSec = cfg.coverageBinSec;
  const nBins = Math.ceil(refDurationSec / binSec);
  const counts = new Int32Array(nBins);
  for (const t of refTimes) {
    const b = Math.min(Math.floor(t / binSec), nBins - 1);
    counts[b]++;
  }
  const intervals = [];
  let start = null, hole = 0;
  for (let i = 0; i < nBins; i++) {
    if (counts[i] >= cfg.minMatchesPerBin) {
      if (start === null) start = i;
      hole = 0;
    } else if (start !== null) {
      hole++;
      if (hole > cfg.maxHoleBins) {
        intervals.push([start * binSec, i * binSec]);
        start = null;
        hole = 0;
      }
    }
  }
  if (start !== null) {
    intervals.push([start * binSec, Math.min(nBins * binSec, refDurationSec)]);
  }
  return intervals;
}

function analyzeMerged(clusters, refDurationSec, refHashCount, cfg) {
  const matches = clusters.flatMap((c) => c.matches);
  const refTimes = matches.map((m) => m.refTime);
  const qTimes = matches.map((m) => m.queryTime);
  const intervals = coveredIntervals(refTimes, refDurationSec, cfg);
  let coveredTime = 0;
  for (const [s, e] of intervals) coveredTime += e - s;
  const spanStart = intervals.length ? intervals[0][0] : 0;
  const spanEnd = intervals.length ? intervals[intervals.length - 1][1] : 0;
  let interiorGap = null;
  for (let i = 0; i + 1 < intervals.length; i++) {
    const g = intervals[i + 1][0] - intervals[i][1];
    if (interiorGap === null || g > interiorGap) interiorGap = g;
  }
  const refDensity = refHashCount / refDurationSec;
  const observedDensity = coveredTime > 0 ? matches.length / coveredTime : 0;
  // offset consistency
  const offsets = matches.map((m) => m.offset).sort((a, b) => a - b);
  const median = (arr) => {
    const n = arr.length;
    return n % 2 ? arr[(n - 1) >> 1] : (arr[n / 2 - 1] + arr[n / 2]) / 2;
  };
  const med = median(offsets);
  const devs = offsets.map((o) => Math.abs(o - med)).sort((a, b) => a - b);
  const mad = median(devs);
  const tol = Math.max(2 * mad, 0.012);
  const focused = offsets.filter((o) => Math.abs(o - med) <= tol).length / (offsets.length || 1);

  return {
    match_count: matches.length,
    ref_duration_sec: refDurationSec,
    matched_ref_intervals: intervals.map(([s, e]) => [r4(s), r4(e)]),
    covered_time_sec: r4(coveredTime),
    coverage_fraction: refDurationSec ? r4(coveredTime / refDurationSec) : 0,
    matched_reference_start_sec: r4(spanStart),
    matched_reference_end_sec: r4(spanEnd),
    missing_head_sec: r4(spanStart),
    missing_tail_sec: r4(Math.max(refDurationSec - spanEnd, 0)),
    largest_interior_gap_sec: interiorGap === null ? null : r4(interiorGap),
    observed_start_sec: r4(Math.min(...qTimes)),
    observed_end_sec: r4(Math.max(...qTimes)),
    match_density_per_sec: r2(observedDensity),
    density_ratio: refDensity ? r4(observedDensity / refDensity) : null,
    offset_mad_sec: r6(mad),
    alignment_focused_ratio: r4(focused),
  };
}

export function analyzeReference(clusters, refDurationSec, refHashCount, selfProfile, cfg) {
  const merged = analyzeMerged(clusters, refDurationSec, refHashCount, cfg);
  const primary = clusters.reduce((a, b) => (b.matches.length > a.matches.length ? b : a));
  merged.offset_sec = r4(primary.offsetSec);
  merged.observed_start_sec = r4(Math.min(...primary.matches.map((m) => m.queryTime)));
  merged.observed_end_sec = r4(Math.max(...primary.matches.map((m) => m.queryTime)));
  merged.cluster_count = clusters.length;
  if (selfProfile) {
    const selfCov = selfProfile.coverage_fraction || 1e-6;
    const selfDensity = selfProfile.match_density_per_sec || 1e-6;
    merged.self_coverage_fraction = r4(selfCov);
    merged.coverage_ratio = r4(merged.coverage_fraction / selfCov);
    merged.density_self_ratio = r4(merged.match_density_per_sec / selfDensity);
    merged.excess_head_sec = r4(Math.max(0, merged.missing_head_sec - (selfProfile.missing_head_sec || 0)));
    merged.excess_tail_sec = r4(Math.max(0, merged.missing_tail_sec - (selfProfile.missing_tail_sec || 0)));
    merged.excess_gap_sec = r4(Math.max(0, (merged.largest_interior_gap_sec ?? 0) - (selfProfile.largest_interior_gap_sec || 0)));
  }
  return merged;
}

/* ---------- classification (classifier.py policy) ----------------------- */

export function classifyFullVsPartial(features, th) {
  const excessHead = features.excess_head_sec ?? 0;
  const excessTail = features.excess_tail_sec ?? 0;
  const excessGap = features.excess_gap_sec ?? 0;
  const coverageRatio = features.coverage_ratio ?? features.coverage_fraction ?? 1;
  const quality = features.density_self_ratio ?? 1;

  const flags = [];
  if (excessHead > th.headTolSec) flags.push(['excess_head', excessHead, th.headTolSec]);
  if (excessTail > th.tailTolSec) flags.push(['excess_tail', excessTail, th.tailTolSec]);
  if (excessGap > th.interiorGapTolSec) flags.push(['excess_gap', excessGap, th.interiorGapTolSec]);

  if (!flags.length) {
    if (coverageRatio < th.coverageRatioFloor) {
      return {
        cls: 'insufficient_signal',
        rationale: `no cut evidence but only ${coverageRatio.toFixed(2)}x of the reference's self-coverage verified`,
        confidence: 0.4,
      };
    }
    return { cls: 'full', rationale: 'all evidence within full-playback margins (self-normalized)', confidence: 0.99 };
  }
  const labels = flags.map(([n, v]) => `${n}=${v.toFixed(2)}s`).join(', ');
  if (quality < th.accusationDensityMin) {
    return {
      cls: 'manual_review',
      rationale: `timeline deviation (${labels}) under poor evidence quality (density ${quality.toFixed(2)}x); cannot separate noise masking from truncation`,
      confidence: 0.5,
    };
  }
  if (flags.length === 1 && coverageRatio >= th.reviewCoverageRatioFloor) {
    const [name, value, tol] = flags[0];
    if (value <= 2 * tol) {
      return {
        cls: 'manual_review',
        rationale: `marginal full/partial evidence (${name}=${value.toFixed(2)}s, coverage ${coverageRatio.toFixed(2)}x)`,
        confidence: 0.5,
      };
    }
  }
  return { cls: 'partial', rationale: `partial playback: ${labels}`, confidence: 0.9 };
}

/* ---------- orchestration ---------------------------------------------- */

/** Full free-check verification of one creative against one episode.
    Both pcm args are Float32Array mono at FP_CONFIG.sampleRate. */
export async function verify(creativePcm, episodePcm, onProgress) {
  const cfg = FP_CONFIG;
  onProgress?.('fingerprint', 0.05);
  const refPeaks = findPeaks(creativePcm, cfg, (s, p) => onProgress?.(s, p * 0.1));
  const refPrints = fingerprintsFromPeaks(refPeaks, cfg);
  const refDurationSec = creativePcm.length / cfg.sampleRate;
  const refHashCount = refPrints.length;

  // self-match profile (null model): the creative against itself
  const selfIndex = buildIndex(refPrints);
  const selfClusters = alignCandidates(refPrints, selfIndex, MATCH_CONFIG);
  const selfProfile = selfClusters.length
    ? analyzeReference(selfClusters, refDurationSec, refHashCount, null, FORENSIC_CONFIG)
    : null;

  onProgress?.('fingerprint', 0.15);
  const epPeaks = findPeaks(episodePcm, cfg, (s, p) => onProgress?.(s, 0.15 + p * 0.8));
  const epPrints = fingerprintsFromPeaks(epPeaks, cfg);
  onProgress?.('match', 0.96);

  const index = buildIndex(refPrints);
  const clusters = alignCandidates(epPrints, index, MATCH_CONFIG);

  // dispatch mirrors classifier.classify for the single-reference case:
  // no cluster -> not_detected; cluster under 30 matches ->
  // insufficient_signal; else full/partial/manual_review
  if (!clusters.length) {
    onProgress?.('done', 1);
    return {
      match_type: 'not_detected',
      rationale: 'no candidate reached the claim threshold',
      confidence: 0.95,
      offset_sec: null,
      episode_duration_sec: episodePcm.length / cfg.sampleRate,
      ref_duration_sec: refDurationSec,
      match_count: 0,
    };
  }
  const topCount = clusters[0].matches.length;
  if (topCount < THRESHOLDS.minEvidenceMatches) {
    onProgress?.('done', 1);
    return {
      match_type: 'insufficient_signal',
      rationale: `only ${topCount} aligned matches (< ${THRESHOLDS.minEvidenceMatches})`,
      confidence: 0.4,
      offset_sec: clusters[0].offsetSec,
      episode_duration_sec: episodePcm.length / cfg.sampleRate,
      ref_duration_sec: refDurationSec,
      match_count: topCount,
    };
  }

  const features = analyzeReference(
    clusters, refDurationSec, refHashCount, selfProfile, FORENSIC_CONFIG,
  );
  const { cls, rationale, confidence } = classifyFullVsPartial(features, THRESHOLDS);
  onProgress?.('done', 1);
  return {
    match_type: cls,
    rationale,
    confidence,
    offset_sec: features.offset_sec,
    episode_duration_sec: episodePcm.length / cfg.sampleRate,
    ref_duration_sec: refDurationSec,
    match_count: features.match_count,
    coverage_ratio: features.coverage_ratio ?? features.coverage_fraction,
    covered_time_sec: features.covered_time_sec,
    missing_head_sec: features.missing_head_sec,
    missing_tail_sec: features.missing_tail_sec,
    evidence: features,
  };
}

/* ---------- helpers ----------------------------------------------------- */

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** WAV (PCM16) -> mono Float32 at native rate. Node validation path. */
export function decodeWavPcm16(buffer) {
  const b = buffer instanceof DataView ? buffer : new DataView(buffer);
  const tag = String.fromCharCode(b.getUint8(0), b.getUint8(1), b.getUint8(2), b.getUint8(3));
  if (tag !== 'RIFF') throw new Error('not a RIFF/WAV file');
  let off = 12;
  let channels = 1, sampleRate = 44100, bits = 16, fmt = 1, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.byteLength) {
    const id = String.fromCharCode(
      b.getUint8(off), b.getUint8(off + 1), b.getUint8(off + 2), b.getUint8(off + 3),
    );
    const size = b.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = b.getUint16(off + 8, true);
      channels = b.getUint16(off + 10, true);
      sampleRate = b.getUint32(off + 12, true);
      bits = b.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0 || fmt !== 1 || bits !== 16) {
    throw new Error(`unsupported WAV (fmt=${fmt} bits=${bits}); need PCM16`);
  }
  const n = Math.floor(dataLen / (2 * channels));
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += b.getInt16(dataOff + (i * channels + c) * 2, true) / 32768;
    }
    pcm[i] = acc / channels;
  }
  return { pcm, sampleRate };
}

/** Anti-aliased decimation/resample by rational factor (windowed-sinc FIR,
    scipy resample_poly equivalent for the common integer cases). */
export function resample(mono, srIn, srOut) {
  if (srIn === srOut) return mono;
  const g = gcd(srIn, srOut);
  const up = srOut / g, down = srIn / g;
  const nOut = Math.floor((mono.length * up) / down);
  if (up === 1 && down === 2) {
    // half-band FIR (129 taps), then decimate
    const taps = 129, half = taps >> 1;
    const h = new Float64Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = (i - half) / 2; // cutoff at 0.25 cycles/sample (input rate)
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
      sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    const out = new Float32Array(nOut);
    for (let o = 0; o < nOut; o++) {
      const center = o * 2;
      let acc = 0;
      for (let k = 0; k < taps; k++) {
        const idx = center - half + k;
        if (idx >= 0 && idx < mono.length) acc += mono[idx] * h[k];
      }
      out[o] = acc;
    }
    return out;
  }
  // general fallback: linear interpolation (validation only uses the 2:1 path)
  const out = new Float32Array(nOut);
  const ratio = srIn / srOut;
  for (let i = 0; i < nOut; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const frac = x - i0;
    out[i] = mono[i0] * (1 - frac) + (mono[i0 + 1] ?? 0) * frac;
  }
  return out;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
