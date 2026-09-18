// ============================================================================
// Katsuyō Academy — Azure Speech authorization-token issuer
// File location in your Vercel project: /api/speech-token.js
//
// Why this exists: the browser needs to talk to Azure Speech directly, so that
// the microphone streams to Azure rather than through this backend — that is
// what makes words appear as you speak instead of a second after you stop.
// But the subscription key must never reach a browser. Azure's answer is an
// authorization token: a short-lived credential minted from the key, good for
// ten minutes, that can do nothing but start a recognition session.
//
// So the key lives here, the browser gets a token, and the token expires long
// before it is worth stealing.
//
// Requires the SAME env vars /api/tts.js already uses — nothing new to set up:
//   AZURE_SPEECH_KEY     — Key 1 from the resource's "Keys and Endpoint" page
//   AZURE_SPEECH_REGION  — the resource Location, lowercased, e.g. "westus3"
//
//   GET /api/speech-token → { success: true, token, region, expiresIn }
// ============================================================================

const ALLOWED_ORIGINS = [
  'https://katsuyoacademy.com',
  'https://www.katsuyoacademy.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

// Azure fixes the token lifetime at 10 minutes; we cannot shorten it. What we
// can do is refuse to hand them out in bulk. A learner needs one token per
// ten minutes of speaking practice, so anything past a handful per minute is
// not a learner.
//
// Best-effort, like the TTS limiter: serverless instances come and go and do
// not share this map, so it stops one client hammering one instance, not a
// determined distributed abuser. The hard ceiling is the Azure budget — set
// one. With the token endpoint live that stops being optional.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_TOKENS = 6;          // per IP per minute
const buckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now - v.start > RATE_WINDOW_MS) buckets.delete(k);
    }
  }
  b.count += 1;
  return b.count > RATE_MAX_TOKENS;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// A token is good for 10 minutes. Re-minting one per instance per 8 minutes
// keeps a burst of learners from each costing a round trip to Azure, while
// never handing out something about to expire mid-sentence.
let tokenCache = { at: 0, token: null };
const TOKEN_REUSE_MS = 8 * 60 * 1000;
const TOKEN_TTL_SECONDS = 9 * 60;   // what we promise the client, conservatively

async function issueToken(key, region) {
  if (tokenCache.token && Date.now() - tokenCache.at < TOKEN_REUSE_MS) {
    return tokenCache.token;
  }
  const r = await fetch(
    'https://' + region + '.api.cognitive.microsoft.com/sts/v1.0/issueToken',
    { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' } }
  );
  if (!r.ok) throw new Error('issueToken failed: HTTP ' + r.status);
  const token = await r.text();
  if (!token) throw new Error('issueToken returned an empty token');
  tokenCache = { at: Date.now(), token: token };
  return token;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Only our own pages may mint tokens. A browser cannot forge Origin, so this
  // is a real check against another site embedding the microphone on our bill.
  // A missing Origin (curl, a same-origin fetch) is allowed through: the rate
  // limit and the Azure budget are what stand behind it.
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ success: false, error: 'Origin not allowed' });
  }

  const key = process.env.AZURE_SPEECH_KEY;
  const region = (process.env.AZURE_SPEECH_REGION || '').trim().toLowerCase();
  if (!key || !region) {
    console.error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set');
    // 503, matching /api/tts: the client reads this as "speech input is not
    // available here" and hides the microphone rather than showing an error.
    return res.status(503).json({ success: false, error: 'Speech input not configured' });
  }

  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }

  try {
    const token = await issueToken(key, region);
    // Never let a CDN or a browser cache a credential.
    res.setHeader('Cache-Control', 'no-store, private');
    return res.status(200).json({
      success: true,
      token: token,
      region: region,
      expiresIn: TOKEN_TTL_SECONDS
    });
  } catch (err) {
    console.error('speech-token error:', err.message);
    return res.status(502).json({ success: false, error: 'Could not issue a speech token' });
  }
}
