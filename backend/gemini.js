'use strict';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Ek ek karke try hote hain, jo pehle jawab de wahi chalta hai.
// FIX: pehle yahan aise model names the jo is API par exist hi nahi karte
// (gemini-3.5-flash, gemini-3.1-flash-lite) - isliye Prompt Ideas page
// 404/400 par "Gemini request failed" dikhata tha.
// Ab sirf real model names hain, aur agar ye sab fail ho jayein to
// discoverModel() Google se live list maang leta hai.
const MODEL_CANDIDATES = [
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
];

/**
 * Work out what kind of credential we were handed, without ever printing
 * the whole thing to the console.
 */
function describeKey(raw) {
  const key = (raw || '').trim();
  if (!key) return { present: false, masked: '(none)', kind: 'missing' };

  const masked =
    key.length <= 12 ? `${key.slice(0, 3)}…` : `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;

  let kind = 'unknown format';
  if (key.startsWith('AQ.')) kind = 'new "AQ." Authentication Key';
  else if (key.startsWith('AIza')) kind = 'legacy "AIza" API key';
  else if (key.startsWith('ya29.')) kind = 'OAuth access token — not an API key';

  return { present: true, masked, kind, isAq: key.startsWith('AQ.') };
}

const SYSTEM_INSTRUCTION = `
You are an expert animation director and physics-aware prompt engineer for
short-form oddly-satisfying 3D videos. Your prompts are intended for a
generative video model, so make every physical relationship visually obvious.

Create ONE original concept per request. Favor mechanisms that naturally obey
real-world physics: rolling spheres, ramps, tracks, pendulums, dominoes,
gears, marbles, springs, water wheels, pinball ramps, sand, liquid, magnets,
and mechanical toys. Vary objects, materials and palettes; avoid the supplied
previous ideas.

Write ONE dense paragraph of roughly 130-180 words in this order:
Subject + physical setup + action + environment + camera + lighting + render style.

PHYSICS FIDELITY IS THE TOP PRIORITY:
- Explicitly define gravity, mass/inertia, friction, traction, collision/contact,
  momentum and believable acceleration/deceleration where relevant.
- Every moving object must have a clear physical support/contact path. It must
  never float, teleport, clip through geometry, or change direction without a
  visible force/contact.
- For rolling objects, state that the object rolls without slipping where
  appropriate, with visible rotational correspondence to translation.
- For impacts, state that collisions transfer momentum and produce believable
  secondary motion, vibration or rebound.
- For pendulums/springs, describe gravity/restoring force and natural damping.
- For liquids/sand, require continuous flow, gravity-driven behavior and
  conservation-like continuity; no popping or discontinuous volume changes.
- Keep object dimensions, mass, materials and geometry consistent throughout.
- Use a single coherent continuous 5-second action, with no impossible cuts
  during the physical event.

CAMERA:
Use a completely static, fixed three-quarter or side shot unless the user
explicitly requests camera motion. The camera must not create fake motion.

LOOP:
If loop is requested, explicitly say seamless infinite loop and that the final
frame matches the first in object position, rotation, and visible state.
If loop is not requested, make it a single continuous 5-second clip and do not
mention looping.

VISUAL QUALITY:
Use soft diffused studio lighting plus realistic contact shadows and subtle
bounce/rim light. Specify hyper-realistic 3D render, Blender Cycles style,
clean minimalist oddly-satisfying product aesthetic, physically plausible
materials, crisp geometry, 4K look, natural motion blur and realistic depth
of field.

WATERMARK:
Include this exact sentence as a prompt hint:
A small, clean, minimal white text watermark reading "MarbleVortex3D" sits in
the bottom-right corner, semi-transparent, unobtrusive.
The application will also burn this watermark into the final MP4 after
generation, so the final file must contain it even if the video model ignores
the prompt hint.

Output ONLY the finished prompt text. No title, bullets, markdown, quotation
marks, or explanation.
`.trim();

function buildUserMessage(loop, previousIdeas) {
  const loopInstruction = loop
    ? 'This idea MUST be a seamless infinite loop (see rule 2 above).'
    : 'This idea must NOT loop — a single continuous 5-second clip (see rule 3 above).';

  const avoidBlock =
    previousIdeas.length > 0
      ? `Avoid repeating the concept, main object, or material used in any of these previous prompts:\n${previousIdeas
          .map((p, i) => `${i + 1}. ${p}`)
          .join('\n')}`
      : 'No previous prompts yet — any concept is fine.';

  return `Generate one new idea now.\n${loopInstruction}\n\n${avoidBlock}`;
}

/** Pull the text out of a response, whichever shape the SDK returns. */
function extractText(response) {
  if (!response) return '';
  if (typeof response.text === 'string') return response.text;
  if (typeof response.text === 'function') return response.text() || '';
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p) => p.text || '')
    .join('')
    .trim();
}

/** Turn any failure into an error object the route can report usefully. */
function toRichError(rawMessage, status) {
  const msg = String(rawMessage || '');
  const err = new Error(msg);
  err.httpStatus = status || 500;
  err.detail = msg;

  if (status === 401 || /UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED|API key not valid/i.test(msg)) {
    err.friendly = 'Gemini rejected the API key (401).';
    err.hint =
      'Keys starting with "AQ." need @google/genai v2+. Run: npm install --prefix backend. ' +
      'If it still fails, regenerate the key at https://aistudio.google.com/apikey';
  } else if (status === 403) {
    err.friendly = 'The key is valid, but the Generative Language API is not enabled for its project (403).';
    err.hint = 'Enable "Generative Language API" in Google Cloud, or create a key in a fresh project.';
  } else if (status === 429) {
    err.friendly = 'Rate limit or free-tier quota reached (429).';
    err.hint = 'Wait a minute and try again, or check quota/billing in AI Studio.';
  } else if (status === 400 && /model|not found|not supported/i.test(msg)) {
    err.friendly = 'Yeh model name is key ke liye available nahi hai (400).';
    err.hint = 'https://ai-video-maker-anything.vercel.app/api/prompt/models kholkar available models dekhein.';
  } else if (status === 404) {
    err.friendly = 'That model name is not available for this key (404).';
    err.hint = 'Open https://ai-video-maker-anything.vercel.app/api/prompt/models to see which models you can use.';
  } else if (/fetch failed|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(msg)) {
    err.friendly = 'Could not reach Google.';
    err.hint = 'Check your internet connection, VPN or firewall.';
  } else {
    err.friendly = 'The Gemini request failed.';
  }
  return err;
}

/**
 * Direct REST call. Sends the credential as the `x-goog-api-key` header,
 * which is the form the new "AQ." Authentication Keys require. This is the
 * fallback used if the installed SDK still can't handle the key.
 */
async function restGenerate({ apiKey, model, userMessage }) {
  const r = await fetch(`${API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      generationConfig: { temperature: 1.15 },
    }),
  });

  const raw = await r.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // A proxy / captive portal / firewall answered instead of Google.
    const err = new Error('Non-JSON response');
    err.httpStatus = 502;
    err.detail = `Google did not return JSON (HTTP ${r.status}). Response: ${raw.slice(0, 160)}`;
    err.friendly = 'Something other than Google answered the request.';
    err.hint = 'Check for a proxy, VPN, corporate firewall or antivirus intercepting HTTPS.';
    throw err;
  }

  if (!r.ok) {
    throw toRichError(body?.error?.message || `HTTP ${r.status}`, r.status);
  }
  return extractText(body);
}

/**
 * Aakhri sahara: Google se poochho ki is key ke liye kaun se models
 * available hain, aur pehla flash-type model use karo.
 */
async function discoverModel(apiKey) {
  try {
    const r = await fetch(`${API_BASE}/models`, {
      headers: { 'x-goog-api-key': apiKey },
    });

    if (!r.ok) return null;

    const body = await r.json();

    const usable = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((name) => !/embedding|aqa|vision-only/i.test(name));

    return (
      usable.find((n) => /flash/i.test(n) && !/lite|thinking/i.test(n)) ||
      usable.find((n) => /flash/i.test(n)) ||
      usable[0] ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * Ask Gemini for one prompt. Tries the SDK first, falls back to a raw REST
 * call, and walks down the model list if a model name is unavailable.
 */
async function generatePrompt({ ai, apiKey, loop, previousIdeas }) {
  const userMessage = buildUserMessage(loop, previousIdeas);
  let lastError = null;

  for (const model of MODEL_CANDIDATES) {
    // 1) the official SDK (agar SDK load ho paaya ho)
    if (ai) try {
      const response = await ai.models.generateContent({
        model,
        contents: userMessage,
        config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 1.15 },
      });
      const text = extractText(response).trim();
      if (text) return { text, model };
      lastError = toRichError('Model returned an empty response.', 502);
    } catch (err) {
      const status = err.status || err.code || err.response?.status;
      lastError = toRichError(err.message || err, Number(status) || undefined);
    }

    // 2) raw REST with the x-goog-api-key header
    try {
      const text = (await restGenerate({ apiKey, model, userMessage })).trim();
      if (text) return { text, model: `${model} (rest)` };
    } catch (err) {
      lastError = err;
    }

    /*
     * 404 / 400 = ye model name is key ke liye available nahi hai,
     * agla naam try karo. 401/403/429 har model par same fail hoga,
     * isliye wahin ruk jao.
     *
     * FIX: pehle sirf 404 skip hota tha, isliye ek galat/retire
     * model name poore page ko "Gemini request failed" de deta tha.
     */
    const status = lastError?.httpStatus;

    if (status && status !== 404 && status !== 400 && status !== 502) {
      break;
    }
  }

  /*
   * Sab known model names fail ho gaye (aksar isliye ki naam badal gaya).
   * Google se live list lekar ek aakhri koshish.
   */
  if (!lastError?.httpStatus || [400, 404, 502].includes(lastError.httpStatus)) {
    const discovered = await discoverModel(apiKey);

    if (discovered && !MODEL_CANDIDATES.includes(discovered)) {
      try {
        const text = (
          await restGenerate({ apiKey, model: discovered, userMessage })
        ).trim();

        if (text) return { text, model: `${discovered} (auto-detected)` };
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || toRichError('Unknown failure talking to Gemini.', 502);
}

module.exports = {
  MODEL_CANDIDATES,
  SYSTEM_INSTRUCTION,
  describeKey,
  generatePrompt,
  discoverModel,
  extractText,
};
