/* Validates the JS free-check engine (src/lib/engine/fp-core.js) against
   the Python Aircheck engine's ground truth: the demo campaign WAVs in
   the engine repo, whose expected classifications, offsets and coverage
   are recorded in audits/demo/reports/evidence.jsonl.

   Ground truth (from the Python run, aircheck 0.6.0):
     CR_A:v1 vs C_001_full   -> full,     offset 90.001s, coverage_ratio 1.0,  matches 3350
     CR_A:v1 vs C_002_partial-> partial,  coverage_ratio 0.8083, missing_tail 5.75s
     CR_A:v1 vs C_004_none   -> not_detected
     CR_A:v1 vs itself       -> full (self profile sanity)

   Run: node scripts/validate-engine.mjs [path-to-aircheck-repo]
   Exits non-zero on any assertion failure. */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  FP_CONFIG,
  decodeWavPcm16,
  resample,
  verify,
} from '../src/lib/engine/fp-core.js';

const aircheckRoot = resolve(
  process.argv[2] ?? join('..', 'aircheck'),
);
const media = (f) => join(aircheckRoot, 'audits', 'demo', 'media', f);

function loadPcm(file) {
  const raw = readFileSync(media(file));
  const { pcm, sampleRate } = decodeWavPcm16(raw.buffer.slice(
    raw.byteOffset, raw.byteOffset + raw.byteLength,
  ));
  const mono = resample(pcm, sampleRate, FP_CONFIG.sampleRate);
  return mono;
}

let failures = 0;
function check(name, cond, detail) {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const fmt = (x, d = 2) => (x === null || x === undefined ? 'null' : x.toFixed(d));

async function main() {
  console.log('Loading demo audio (PCM16 WAV -> mono 22.05 kHz)...');
  const t0 = Date.now();
  const creative = loadPcm('CR_A_v1.wav');
  const full = loadPcm('C_001_full.wav');
  const partial = loadPcm('C_002_partial.wav');
  const none = loadPcm('C_004_none.wav');
  console.log(`  loaded 4 files in ${Date.now() - t0}ms (creative ${creative.length} samples)`);

  console.log('\n[1] Full delivery: CR_A:v1 inside C_001 (expected full @ ~90.0s)');
  const r1 = await verify(creative, full);
  check('classification is full', r1.match_type === 'full', `got ${r1.match_type}`);
  check('offset ~90.0s', Math.abs(r1.offset_sec - 90.0) < 0.2, `offset ${fmt(r1.offset_sec, 3)}s`);
  check('coverage_ratio >= 0.9', r1.coverage_ratio >= 0.9, `ratio ${fmt(r1.coverage_ratio, 3)}`);
  check('match_count >= 2000', r1.match_count >= 2000, `matches ${r1.match_count} (python: 3350)`);

  console.log('\n[2] Partial delivery: CR_A:v1 vs C_002 (expected partial, tail ~5.75s missing)');
  const r2 = await verify(creative, partial);
  check('classification is partial', r2.match_type === 'partial', `got ${r2.match_type}`);
  check('missing_tail ~5.75s', Math.abs(r2.missing_tail_sec - 5.75) < 0.6, `tail ${fmt(r2.missing_tail_sec)}s`);
  check('coverage_ratio in 0.7–0.95', r2.coverage_ratio >= 0.7 && r2.coverage_ratio <= 0.95, `ratio ${fmt(r2.coverage_ratio, 3)}`);

  console.log('\n[3] No occurrence: CR_A:v1 vs C_004 (expected not_detected)');
  const r3 = await verify(creative, none);
  check('classification is not_detected', r3.match_type === 'not_detected', `got ${r3.match_type} (${r3.rationale})`);

  console.log('\n[4] Self-match: CR_A:v1 vs itself (expected full @ 0.0s)');
  const r4 = await verify(creative, creative);
  check('classification is full', r4.match_type === 'full', `got ${r4.match_type}`);
  check('offset ~0.0s', Math.abs(r4.offset_sec) < 0.1, `offset ${fmt(r4.offset_sec, 3)}s`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} (total ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('validation crashed:', e);
  process.exit(1);
});
