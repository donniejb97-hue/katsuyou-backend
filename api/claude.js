// ============================================================================
// Katsuyō Academy — Vercel backend for Claude AI features
// File location in your Vercel project: /api/claude.js
//
// Frontend contract (unchanged — ai.js and sensei.js work as-is):
//   POST { prompt: string, maxTokens: number }
//   → { success: true,  feedback: string, usage: {...}, model: string }
//   → { success: false, error: string }
//
// Requires env var ANTHROPIC_API_KEY set in Vercel project settings.
// ============================================================================

// Models to try, in order. If the first one is ever deprecated/unavailable,
// the backend automatically falls back to the next — no more dropped
// connections just because a model was retired.
// Current strings verified July 2026. Full list:
// https://docs.claude.com/en/docs/about-claude/models/overview
const MODELS = [
  'claude-sonnet-4-6',   // primary: fast, affordable, great for tutoring
  'claude-haiku-4-5',    // fallback 1: cheapest/fastest
  'claude-opus-4-8'      // fallback 2: most capable
];

const ALLOWED_ORIGINS = [
  'https://katsuyoacademy.com',
  'https://www.katsuyoacademy.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function callClaude(model, prompt, maxTokens, apiKey) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

// A "try the next model" error: invalid/retired model, or model overloaded.
function shouldFallback(status, data) {
  if (status === 404) return true;                       // model not found
  if (status === 529) return true;                       // overloaded
  const errType = data && data.error && data.error.type;
  const errMsg = (data && data.error && data.error.message) || '';
  if (errType === 'not_found_error') return true;
  if (status === 400 && /model/i.test(errMsg)) return true; // bad model string
  return false;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ success: false, error: 'Server not configured' });
  }

  const { prompt, maxTokens } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing prompt' });
  }

  // Basic sanity caps so a bad request can't run up the bill
  const cappedTokens = Math.min(Math.max(parseInt(maxTokens, 10) || 500, 50), 2000);
  const cappedPrompt = prompt.slice(0, 8000);

  let lastError = 'Unknown error';

  for (const model of MODELS) {
    try {
      const { ok, status, data } = await callClaude(model, cappedPrompt, cappedTokens, apiKey);

      if (ok) {
        const text = (data.content || [])
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n')
          .trim();

        if (!text) {
          lastError = 'Empty response from model';
          continue;
        }

        return res.status(200).json({
          success: true,
          feedback: text,
          usage: data.usage || null,
          model: model
        });
      }

      // Not ok — decide whether to fall back or report the error
      lastError = (data.error && data.error.message) || ('HTTP ' + status);
      console.error('Model ' + model + ' failed (' + status + '):', lastError);

      if (!shouldFallback(status, data)) {
        // Auth error, rate limit, bad request unrelated to model — trying
        // other models won't help, so report it now.
        return res.status(status).json({ success: false, error: lastError });
      }
      // else: loop continues to the next model
    } catch (err) {
      lastError = err.message || 'Network error';
      console.error('Model ' + model + ' threw:', lastError);
      // Network hiccup — try the next model anyway
    }
  }

  return res.status(502).json({
    success: false,
    error: 'All models unavailable. Last error: ' + lastError
  });
}
