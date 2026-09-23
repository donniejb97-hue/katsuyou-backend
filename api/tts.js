// ============================================================================
// Katsuyō Academy — Azure Neural TTS proxy
// File location in your Vercel project: /api/tts.js
//
// Why a proxy at all: the Azure key must never reach the browser. Anyone with
// it can spend your money.
//
// Two jobs:
//   GET  /api/tts?voices=1   → the live ja-JP voice list (cached 24h)
//   POST /api/tts {text, voice, style} → audio/mpeg   (Japanese)
//   GET  /api/tts?voices=1&lang=en   → that language's voice list
//   POST /api/tts {text, lang: en|de|fr|zh, voice?, jaVoice?} → audio/mpeg
//        (Katsu's replies: Japanese runs inside the text get jaVoice)
//
// Requires these env vars in Vercel project settings:
//   AZURE_SPEECH_KEY     — Key 1 from the resource's "Keys and Endpoint" page
//   AZURE_SPEECH_REGION  — the resource Location, lowercased, e.g. "eastus"
// ============================================================================

const ALLOWED_ORIGINS = [
  'https://katsuyoacademy.com',
  'https://www.katsuyoacademy.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

// Azure bills Japanese at TWO characters each, so this cap is half what it
// looks like in spend terms. A word or reading is ~40 characters; a Katsu
// reply read aloud (the `lang` path) runs a few hundred, so that path gets a
// larger cap. Either way an over-long text is cut at a sentence end, never
// mid-word.
const MAX_CHARS = 400;
const MAX_REPLY_CHARS = 2000;

function clip(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('. '), head.lastIndexOf('！'), head.lastIndexOf('! '), head.lastIndexOf('？'), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  return (cut >= max / 2 ? head.slice(0, cut + 1) : head).trim();
}

// Only ja-JP neural voices, and only names shaped the way Azure names them.
// Belt and braces: the name is also checked against the live voice list.
const VOICE_PATTERN = /^ja-JP-[A-Za-z0-9]+(Neural|HD|HDLatest)$/;
const DEFAULT_VOICE = 'ja-JP-NanamiNeural';

// Katsu reads his replies aloud in the site's language, so the other four
// languages get one fixed, known-good voice each. `lang` in the request picks
// it; anything not on this list falls through to the Japanese path above.
const LANG_VOICES = {
  en: { locale: 'en-US', voice: 'en-US-JennyNeural' },
  de: { locale: 'de-DE', voice: 'de-DE-KatjaNeural' },
  fr: { locale: 'fr-FR', voice: 'fr-FR-DeniseNeural' },
  zh: { locale: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural' }
};

const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

// ---------------------------------------------------------------------------
// Best-effort rate limiting. Serverless instances come and go, so this catches
// a single client hammering one instance but is NOT a real budget guard — set
// a spending limit on the Azure resource for that.
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 20;      // per IP per minute
const RATE_MAX_CHARS = 12000;      // per IP per minute — a handful of read-aloud replies
const buckets = new Map();

function rateLimit(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > RATE_WINDOW_MS) {
    b = { start: now, count: 0, chars: 0 };
    buckets.set(ip, b);
  }
  // Keep the map from growing without bound on a long-lived instance.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now - v.start > RATE_WINDOW_MS) buckets.delete(k);
    }
  }
  return b;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// SSML is XML. Unescaped text can close the voice element and inject markup,
// so everything the client sends is escaped before it goes anywhere near it.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Voice list, cached in the instance so we're not fetching it per request.
// ---------------------------------------------------------------------------
const voiceCache = {};            // locale → { at, list }
const VOICE_TTL_MS = 24 * 60 * 60 * 1000;

// The live voice list for one locale, cached a day. The default is Japanese;
// Katsu's read-aloud asks for the site language's list to offer a choice.
async function getVoices(key, region, locale) {
  locale = locale || 'ja-JP';
  const hit = voiceCache[locale];
  if (hit && hit.list && Date.now() - hit.at < VOICE_TTL_MS) return hit.list;
  const r = await fetch(
    'https://' + region + '.tts.speech.microsoft.com/cognitiveservices/voices/list',
    { headers: { 'Ocp-Apim-Subscription-Key': key } }
  );
  if (!r.ok) throw new Error('voice list failed: HTTP ' + r.status);
  const all = await r.json();
  // One fetch fills every locale we serve, so the other lists are free.
  const wanted = ['ja-JP'].concat(Object.values(LANG_VOICES).map(v => v.locale));
  wanted.forEach(loc => {
    const list = (all || [])
      .filter(v => v && v.Locale === loc)
      .map(v => ({
        name: v.ShortName,
        display: v.LocalName || v.DisplayName || v.ShortName,
        gender: v.Gender || '',
        styles: v.StyleList || []
      }));
    voiceCache[loc] = { at: Date.now(), list: list };
  });
  return (voiceCache[locale] && voiceCache[locale].list) || [];
}
const getJapaneseVoices = (key, region) => getVoices(key, region, 'ja-JP');

// Azure names voices "<locale>-<Name>Neural"; this is the shape check for any
// locale we serve, before the name is also checked against the live list.
function voicePatternFor(locale) {
  return new RegExp('^' + locale.replace('-', '\\-') + '-[A-Za-z0-9]+(Neural|HD|HDLatest)$');
}

// Katsu's replies mix languages: "食べる means to eat". Read by one English
// voice, the Japanese is sounded out letter by letter; so the text is split
// into runs by script, and each run gets its own <voice>. Azure allows
// several <voice> elements in one <speak>, so this is still one clip.
const JA_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\u3000-\u303f\uff01-\uff0f\uff1a-\uff1f]+/g;
function splitByScript(text) {
  const runs = [];
  let last = 0, m;
  JA_RUN.lastIndex = 0;
  while ((m = JA_RUN.exec(text)) !== null) {
    if (m.index > last) runs.push({ ja: false, text: text.slice(last, m.index) });
    runs.push({ ja: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ ja: false, text: text.slice(last) });
  return runs.filter(r => r.text.trim());
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.AZURE_SPEECH_KEY;
  const region = (process.env.AZURE_SPEECH_REGION || '').trim().toLowerCase();
  if (!key || !region) {
    console.error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set');
    // 503 rather than 500: the client treats this as "fall back to the
    // browser voice", which is exactly right when TTS isn't configured.
    return res.status(503).json({ success: false, error: 'TTS not configured' });
  }

  // ---- voice list -----------------------------------------------------
  if (req.method === 'GET') {
    try {
      const q = (req.query && req.query.lang) || '';
      const loc = (typeof q === 'string' && LANG_VOICES[q]) ? LANG_VOICES[q].locale : 'ja-JP';
      const voices = await getVoices(key, region, loc);
      // Deliberately NOT a public cache. Opening this URL in a browser sends no
      // Origin, so the response carries no Access-Control-Allow-Origin — and a
      // shared cache would then serve that header-less copy to the site's own
      // fetch, which the browser blocks. Vary:Origin should prevent it; not
      // relying on that. The 24h in-instance cache already spares Azure.
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const def = loc === 'ja-JP' ? DEFAULT_VOICE : Object.values(LANG_VOICES).find(v => v.locale === loc).voice;
      return res.status(200).json({ success: true, voices, default: def });
    } catch (err) {
      console.error('voice list error:', err.message);
      return res.status(502).json({ success: false, error: 'Could not list voices' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { text, voice, style, lang, jaVoice } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ success: false, error: 'Missing text' });
  }

  const clean = clip(text.trim(), LANG_VOICES[lang] ? MAX_REPLY_CHARS : MAX_CHARS);

  // ---- rate limit -----------------------------------------------------
  const ip = clientIp(req);
  const bucket = rateLimit(ip);
  if (bucket.count >= RATE_MAX_REQUESTS || bucket.chars + clean.length > RATE_MAX_CHARS) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ success: false, error: 'Too many requests' });
  }
  bucket.count++;
  bucket.chars += clean.length;

  // ---- voice and speaking style ---------------------------------------
  // A style is only valid for voices that advertise it — ja-JP-NanamiNeural
  // is currently the only Japanese voice with any. Asking for one a voice
  // doesn't have is the kind of thing that fails silently, so the style is
  // checked against that voice's own list and dropped if it isn't there.
  let chosen = DEFAULT_VOICE;
  let chosenStyle = '';
  let voiceList = null;
  let xmlLang = 'ja-JP';

  // A non-Japanese language: that locale's default voice, or one the user
  // picked from that locale's list (checked by shape and against the list).
  // Any Japanese runs inside the text get a Japanese voice of their own.
  const other = (typeof lang === 'string' && lang !== 'ja') ? LANG_VOICES[lang] : null;
  let jaChosen = DEFAULT_VOICE;
  if (other) {
    chosen = other.voice;
    xmlLang = other.locale;
    let otherList = null;
    try { otherList = await getVoices(key, region, other.locale); } catch (e) { otherList = null; }
    if (typeof voice === 'string' && voicePatternFor(other.locale).test(voice)) {
      if (!otherList || otherList.some(v => v.name === voice)) chosen = voice;
    }
    let jaList = null;
    try { jaList = await getJapaneseVoices(key, region); } catch (e) { jaList = null; }
    if (typeof jaVoice === 'string' && VOICE_PATTERN.test(jaVoice)) {
      if (!jaList || jaList.some(v => v.name === jaVoice)) jaChosen = jaVoice;
    }
  }

  if (!other) {
    try {
      voiceList = await getJapaneseVoices(key, region);
    } catch (e) {
      voiceList = null;   // verification unavailable; fall back to pattern checks
    }

    if (typeof voice === 'string' && VOICE_PATTERN.test(voice)) {
      if (!voiceList || voiceList.some(v => v.name === voice)) chosen = voice;
    }
  }

  if (!other && typeof style === 'string' && /^[a-zA-Z-]{1,40}$/.test(style)) {
    const entry = voiceList && voiceList.find(v => v.name === chosen);
    // No list means no way to verify, so no style — better plain than broken.
    if (entry && Array.isArray(entry.styles) && entry.styles.indexOf(style) !== -1) {
      chosenStyle = style;
    }
  }

  let voices;
  if (other) {
    voices = splitByScript(clean).map(run => run.ja
      ? '<voice name="' + jaChosen + '"><prosody rate="-8%">' + escapeXml(run.text) + '</prosody></voice>'
      : '<voice name="' + chosen + '">' + escapeXml(run.text) + '</voice>').join('');
  } else {
    const inner = '<prosody rate="-8%">' + escapeXml(clean) + '</prosody>';
    const body = chosenStyle
      ? '<mstts:express-as style="' + escapeXml(chosenStyle) + '">' + inner + '</mstts:express-as>'
      : inner;
    voices = '<voice name="' + chosen + '">' + body + '</voice>';
  }

  const ssml =
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"' +
      ' xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="' + xmlLang + '">' +
      voices +
    '</speak>';

  try {
    const azure = await fetch(
      'https://' + region + '.tts.speech.microsoft.com/cognitiveservices/v1',
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
          'User-Agent': 'KatsuyoAcademy/1.0'
        },
        body: ssml
      }
    );

    if (!azure.ok) {
      const detail = await azure.text().catch(() => '');
      console.error('Azure TTS failed (' + azure.status + '):', detail.slice(0, 300));
      // 429 from Azure means quota — pass it through so the client backs off.
      const status = azure.status === 429 ? 429 : 502;
      return res.status(status).json({ success: false, error: 'Speech unavailable' });
    }

    const buf = Buffer.from(await azure.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(buf.length));
    // The same sentence and voice always produce the same audio, so let the
    // browser and the CDN keep it.
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.status(200).send(buf);
  } catch (err) {
    console.error('Azure TTS threw:', err.message);
    return res.status(502).json({ success: false, error: 'Speech unavailable' });
  }
}
