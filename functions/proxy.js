/* Cloudflare Pages Function: pass-through media proxy for the free check.

   The free check runs in the visitor's browser; most podcast audio hosts
   do not send CORS headers, so the browser cannot fetch episode audio
   directly. This function streams the remote response through the
   deployment with permissive CORS on OUR response. It stores nothing and
   computes nothing (bytes pass through; free-tier CPU is not consumed
   meaningfully).

   Hardening:
   - http(s) targets only; hostname must not be a private/loopback address
   - response must look like audio, podcast video, an octet-stream, or XML
   - content-length cap (300 MB)
   - soft per-IP rate limit (per isolate; the compute is client-side, so
     this protects bandwidth, not secrets)
*/

const MAX_BYTES = 300 * 1024 * 1024;
const RATE_LIMIT = 12; // requests per minute per IP
const ALLOWED_CT = /^(audio\/|video\/mp4|application\/octet-stream|application\/xml|text\/xml|text\/plain)/;

const hits = new Map(); // ip -> timestamps (per isolate)

function rateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const list = (hits.get(ip) ?? []).filter((t) => now - t < window);
  if (list.length >= RATE_LIMIT) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  return false;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  const corsHeaders = { ...CORS, 'Cache-Control': 'no-store' };

  if (!target) {
    return json({ error: 'missing url parameter' }, 400, corsHeaders);
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json({ error: 'invalid url' }, 400, corsHeaders);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return json({ error: 'only http(s) urls are allowed' }, 400, corsHeaders);
  }
  if (isPrivateHost(parsed.hostname)) {
    return json({ error: 'that host is not reachable' }, 403, corsHeaders);
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (rateLimited(ip)) {
    return json({ error: 'too many requests; wait a minute' }, 429, corsHeaders);
  }

  const upstreamHeaders = {};
  const range = request.headers.get('range');
  if (range) upstreamHeaders['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(parsed.href, {
      headers: upstreamHeaders,
      redirect: 'follow',
      cf: { cacheTtl: 300, cacheEverything: false },
    });
  } catch {
    return json({ error: 'could not reach that url' }, 502, corsHeaders);
  }

  const ct = (upstream.headers.get('content-type') ?? '').split(';')[0].trim();
  const cl = Number(upstream.headers.get('content-length') ?? '0');

  // XML/RSS feeds are allowed through for feed resolution; everything else
  // must look like media
  if (!ALLOWED_CT.test(ct) && ct !== '') {
    return json(
      { error: `unsupported content type "${ct}"; use a direct audio link or RSS feed` },
      415,
      corsHeaders,
    );
  }
  if (cl > MAX_BYTES) {
    return json({ error: 'file too large for the free check (300 MB limit)' }, 413, corsHeaders);
  }

  const headers = {
    ...CORS,
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=600',
  };
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
