const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { AsyncLocalStorage } = require('node:async_hooks');
require('dotenv').config();

const app = express();

// Render runs the app behind a reverse proxy. Trust the first proxy hop so
// rate limiting keys on the real client IP (not Render's shared proxy IP).
app.set('trust proxy', 1);

// The API is only ever called by the mobile app, never by a web page, so no
// browser origin needs access. Keeping CORS wide open let anyone embed our
// paid AI endpoints in a site of their own.
app.use(cors({ origin: false }));
app.use(express.json({ limit: '20mb' }));

// ── App identity gate ─────────────────────────────────────────
// The AI + import routes cost real money per call. They stay open to signed-out
// users (the 3 free Smart Chef tries are a core feature, so we cannot require a
// login), but they must not be callable by anyone who simply discovers the
// server URL. The app sends a shared secret; requests without it are refused.
// If APP_SECRET is unset the gate stays open, so an incomplete deploy can never
// take the live app down.
const APP_SECRET = process.env.APP_SECRET;
function requireAppSecret(req, res, next) {
  if (!APP_SECRET) return next();
  if (req.get('x-app-key') === APP_SECRET) return next();
  return res.status(401).json({ error: 'Unauthorized.' });
}

// ── Per-request language context ──────────────────────────────
// The app sends the user's chosen language in the X-App-Language header. We
// keep it in AsyncLocalStorage rather than a module variable so concurrent
// requests never read each other's language.
const reqCtx = new AsyncLocalStorage();
app.use((req, _res, next) => {
  const raw = String(req.headers['x-app-language'] ?? '').toLowerCase().slice(0, 2);
  // The store is mutated later in the chain: the trial gate writes who the
  // caller is, and the AI adapter records which provider actually served the
  // request and what it cost. Kept per-request so nothing leaks between users.
  reqCtx.run(
    { lang: raw || 'en', userId: null, isPro: false, isOwner: false, provider: null, costCents: 0 },
    next
  );
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Money guards (every one of these is tunable from Render → Environment) ──
// The free trial hands out a fixed budget PER ACCOUNT, held in the database so
// deleting and reinstalling the app cannot reset it.
// PER DAY during the trial, not per trial. A budget spent on day one leaves six
// dead days and a user with nothing worth paying to keep; a daily allowance
// lets someone genuinely live with the app for a week and build a collection.
const TRIAL_DAYS    = Number(process.env.TRIAL_DAYS    || 7);
const TRIAL_IMPORTS = Number(process.env.TRIAL_IMPORTS || 10);
const TRIAL_AI_USES = Number(process.env.TRIAL_AI_USES || 5);

// Hard ceiling on what the PAID model may cost in one day, for people who are
// NOT paying. 100 = $1.00/day = $30/month worst case, whatever happens. This is
// the single most important line in this file: without it there is no upper
// bound at all.
const DAILY_CAP_CENTS = Number(process.env.DAILY_CAP_CENTS || 100);

// PER SUBSCRIBER, per day — not a shared pot. Each paying account is metered on
// its own row, so subscribers can never block one another and a single stolen
// account cannot run up an unbounded bill.
// Sized from measured cost per call: a link import runs 3-4 cents, a scan or a
// Smart Chef answer well under one cent, so even a very heavy genuine day lands
// near $1. 300 cents leaves roughly 3x headroom above that while capping the
// worst case for one abused account at about $90/month instead of $600.
const DAILY_CAP_PRO_CENTS = Number(process.env.DAILY_CAP_PRO_CENTS || 300);

// When false, trial users are served by the FREE providers only — if those are
// down they get an error rather than silently spending money. Subscribers and
// the owner always keep the paid model. Leave true until the free providers are
// proven working in /api/diag, then flip to false and the trial costs $0.
const PAID_FOR_TRIAL = process.env.PAID_FOR_TRIAL !== 'false';

// ON by default: an account is required, and access ends when the trial does.
// The expensive part of this app (a link import costs 3-4 cents in AI) used to
// be free and unlimited to anyone with no account at all, while the cheap part
// was what got charged for — the economics were inverted. Every paid feature
// now sits behind the trial.
// Set REQUIRE_ACCOUNT=false in Render to reopen the app to signed-out visitors.
const REQUIRE_ACCOUNT = process.env.REQUIRE_ACCOUNT !== 'false';

// Refuse accounts whose email was never confirmed. This is the cheap half of
// stopping "new address = new trial" farming; the other half (one trial per
// DEVICE) needs a native module and ships with the next app build.
// IMPORTANT: this only bites once "Confirm email" is enabled in
// Supabase → Authentication → Providers → Email. Until then Supabase marks
// every new user confirmed and this check passes silently.
const REQUIRE_VERIFIED_EMAIL = process.env.REQUIRE_VERIFIED_EMAIL !== 'false';

// OFF by default. The free tiers were measured to be unreliable (timeouts and
// HTTP 503), and trying them first costs the user seconds of waiting before the
// paid model — which actually works — is reached. Haiku answers directly.
// The code path is kept and tested: set USE_FREE_PROVIDERS=true in Render to
// evaluate a free provider later, and /api/diag reports exactly what happens.
const USE_FREE_PROVIDERS = process.env.USE_FREE_PROVIDERS === 'true';

// Claude Haiku 4.5 list price, used to estimate what each paid call cost so the
// daily ceiling can be enforced. Dollars per million tokens.
const HAIKU_IN_PER_MTOK  = 1;
const HAIKU_OUT_PER_MTOK = 5;

// ── Supabase (service role) ───────────────────────────────────
// Server-side client. The service key bypasses row-level security, so it can
// read any profile and consume quota — it must NEVER be sent to the app.
// If the key is missing the trial gate fails OPEN, so a half-finished deploy
// can never take the live app down.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
let db = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
} else {
  console.warn('[BOOT] SUPABASE_SERVICE_KEY missing — trial gate DISABLED (endpoints stay open).');
}

// ── AI provider: Gemini Flash first (free tier), Anthropic Haiku as fallback ──
// Every AI call in this file goes through `ai.messages.create()`, which is a
// drop-in replacement for `anthropic.messages.create()` (same options in, same
// { content: [{ text }] } out). It tries Gemini Flash — which is free — and
// silently falls back to Haiku (paid) whenever Gemini is missing, rate-limited
// or errors, so the app never breaks. Set GEMINI_API_KEY to enable Gemini.
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// "gemini-flash-latest" is an ALIAS that always points at the current Flash
// model. The previous value pinned "gemini-2.0-flash", which Google has since
// retired — every call returned HTTP 404, the failure was swallowed by a
// console warning, and every request silently fell through to the paid model.
// The alias makes that specific failure impossible to repeat.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

// Translate Anthropic-style messages (text blocks + base64 image blocks, as
// used by /api/import/scan) into Gemini's "parts" format.
function toGeminiParts(messages) {
  const parts = [];
  for (const m of messages ?? []) {
    const c = m.content;
    if (typeof c === 'string') { parts.push({ text: c }); continue; }
    for (const block of c ?? []) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'image' && block.source?.data) {
        parts.push({
          inline_data: {
            mime_type: block.source.media_type || 'image/jpeg',
            data: block.source.data,
          },
        });
      }
    }
  }
  return parts;
}

async function callGemini(opts) {
  const parts = toGeminiParts(opts.messages);
  if (!parts.length) throw new Error('no content to send');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          // Current Gemini Flash models "think" before answering, and those
          // hidden thinking tokens come out of the SAME budget as the answer.
          // A probe with maxOutputTokens:16 spent all 16 thinking and returned
          // an empty string — which the old code reported as "provider down"
          // and answered by billing the paid model. Disabling thinking and
          // keeping a real floor under the budget prevents both failures.
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: Math.max(opts.max_tokens ?? 2000, 800),
        },
      }),
      // Short on purpose: a free provider that has not answered in 12s is not
      // worth making the user wait for when a working paid model is one call
      // away.
      signal: AbortSignal.timeout(12000),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (!text) throw new Error('Gemini returned empty text');
  return text;
}

// ── Language + measurement system ─────────────────────────────
// Recipes used to come back in whatever language the source page was written
// in (almost always English) with US units, no matter what language the user
// had picked in the app. These helpers force every model answer into the
// user's language and the right measurement system.
// English targets the US audience → US customary. Every other shipped
// language (de/es/fr) is a metric market.
const LANGUAGE_NAMES = { en: 'English', de: 'German', es: 'Spanish', fr: 'French' };

function langDirective(lang) {
  const code = LANGUAGE_NAMES[lang] ? lang : 'en';
  const name = LANGUAGE_NAMES[code];
  const units = code === 'en'
    ? 'US customary units (cups, tablespoons, teaspoons, ounces, pounds, °F)'
    : 'metric units (grams, millilitres, litres, °C)';
  return `

LANGUAGE AND UNITS — MANDATORY:
- Write every piece of text you output in ${name}, even when the source material is in another language: translate the title, every ingredient name and every instruction step.
- Express every quantity and temperature in ${units}. Convert from the source when needed and round to amounts a cook would actually use.
- JSON field names stay exactly as specified above, in English. Only the VALUES are written in ${name}.`;
}

// Append the directive to the last user message. Content is a plain string for
// text prompts and an array of blocks when an image is attached (recipe scan),
// so both shapes are handled.
function withLangDirective(opts, lang) {
  const directive = langDirective(lang);
  const messages = (opts.messages ?? []).map((m, i, arr) => {
    if (i !== arr.length - 1 || m.role !== 'user') return m;

    if (typeof m.content === 'string') {
      return { ...m, content: m.content + directive };
    }
    if (Array.isArray(m.content)) {
      const content = [...m.content];
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j]?.type === 'text') {
          content[j] = { ...content[j], text: content[j].text + directive };
          return { ...m, content };
        }
      }
      content.push({ type: 'text', text: directive });
      return { ...m, content };
    }
    return m;
  });
  return { ...opts, messages };
}

// ── Free providers (OpenAI-compatible: Groq, Mistral) ─────────
// Both speak the same /chat/completions shape, so one caller covers both and
// adding a third later is a config change, not a code change. Keys are set in
// Render → Environment; a provider with no key is simply skipped.
function toOpenAIMessages(opts) {
  const msgs = [];
  if (opts.system) msgs.push({ role: 'system', content: opts.system });
  for (const m of opts.messages ?? []) {
    const c = m.content;
    if (typeof c === 'string') { msgs.push({ role: m.role, content: c }); continue; }
    const parts = [];
    for (const b of c ?? []) {
      if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source?.data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${b.source.media_type || 'image/jpeg'};base64,${b.source.data}` },
        });
      }
    }
    msgs.push({ role: m.role, content: parts });
  }
  return msgs;
}

async function callOpenAICompatible(p, opts) {
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model,
      messages: toOpenAIMessages(opts),
      max_tokens: opts.max_tokens ?? 1500,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('provider returned empty text');
  return text;
}

// Scanning a photo needs a model that can actually see. Text-only models are
// skipped for those calls instead of being sent an image they will ignore.
function messagesHaveImage(opts) {
  return (opts.messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'image')
  );
}

function freeProviders(needsVision) {
  const list = [];
  if (process.env.GROQ_API_KEY) {
    list.push({
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: process.env.GROQ_API_KEY,
      model: needsVision ? (process.env.GROQ_VISION_MODEL || '')
                         : (process.env.GROQ_MODEL || 'openai/gpt-oss-120b'),
    });
  }
  if (process.env.MISTRAL_API_KEY) {
    list.push({
      name: 'mistral',
      url: 'https://api.mistral.ai/v1/chat/completions',
      key: process.env.MISTRAL_API_KEY,
      model: needsVision ? (process.env.MISTRAL_VISION_MODEL || 'pixtral-12b-2409')
                         : (process.env.MISTRAL_MODEL || 'mistral-small-latest'),
    });
  }
  return list.filter((p) => p.model);
}

// Tries every configured free provider in order. Returns the text on the first
// success, or the list of failures so they can be reported instead of hidden.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free tiers are shared infrastructure: they answer 503 "overloaded" or 429
// "rate limited" from time to time. Those are momentary and worth retrying —
// a 400 or 404 means the request itself is wrong and never will be.
const isTransient = (msg) => /\b(429|500|502|503|504)\b|timeout|aborted|fetch failed|ECONNRESET/i.test(msg);

async function tryFreeProviders(opts) {
  // Disabled: go straight to the model that works, with no waiting.
  if (!USE_FREE_PROVIDERS) return { ok: false, errors: ['free providers disabled'] };

  const needsVision = messagesHaveImage(opts);
  const errors = [];
  const ATTEMPTS = 2;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let sawTransient = false;

    // Gemini goes first: it is the only free provider here that handles BOTH
    // text and images, so the photo scan stays free too.
    if (GEMINI_KEY) {
      try {
        return { ok: true, provider: 'gemini', text: await callGemini(opts) };
      } catch (e) {
        errors.push(`gemini(try ${attempt}): ${e.message}`);
        sawTransient = sawTransient || isTransient(e.message);
        console.warn(`[AI] gemini failed (try ${attempt}) — ${e.message}`);
      }
    }

    for (const p of freeProviders(needsVision)) {
      try {
        return { ok: true, provider: p.name, text: await callOpenAICompatible(p, opts) };
      } catch (e) {
        errors.push(`${p.name}(try ${attempt}): ${e.message}`);
        sawTransient = sawTransient || isTransient(e.message);
        console.warn(`[AI] ${p.name} failed (try ${attempt}) — ${e.message}`);
      }
    }

    // Nothing transient happened, so another identical attempt would fail the
    // same way. Stop and let the caller decide.
    if (!sawTransient) break;
    if (attempt < ATTEMPTS) await sleep(700 * attempt);
  }

  return { ok: false, errors };
}

// ── Daily spend ceilings ──────────────────────────────────────
// TWO separate meters, because the two populations need opposite guarantees:
//   * everyone who is NOT paying shares ONE pooled daily budget. The point is to
//     bound total exposure from free traffic, so pooling is correct.
//   * every subscriber gets their OWN daily budget. Pooling them would let one
//     subscriber's usage lock another one out — which is exactly what a paying
//     customer must never experience.
async function canSpend(unlimited, userId) {
  const capCents = unlimited ? DAILY_CAP_PRO_CENTS : DAILY_CAP_CENTS;
  if (!db) return { allowed: true, spent_cents: 0, cap_cents: capCents };

  const { data, error } = unlimited && userId
    ? await db.rpc('can_spend_user', { p_user: userId, p_cap_cents: capCents })
    : await db.rpc('can_spend', { p_cap_cents: capCents });

  if (error) {
    // Cannot prove we are under the ceiling → refuse to spend. A rare outage is
    // better than an unbounded bill.
    console.error('[SPEND] can_spend failed:', error.message);
    return { allowed: false, error: error.message };
  }
  return data;
}

async function recordSpend(usage, unlimited, userId) {
  if (!db || !usage) return 0;
  const cents = Math.ceil(
    ((usage.input_tokens || 0) / 1e6 * HAIKU_IN_PER_MTOK +
     (usage.output_tokens || 0) / 1e6 * HAIKU_OUT_PER_MTOK) * 100
  );
  const { error } = unlimited && userId
    ? await db.rpc('add_spend_user', { p_user: userId, p_cost_cents: cents })
    : await db.rpc('add_spend', { p_cost_cents: cents });
  if (error) console.error('[SPEND] add_spend failed:', error.message);
  return cents;
}

class AiUnavailable extends Error {
  constructor(message, detail) {
    super(message);
    this.status = 503;
    this.detail = detail;
  }
}

// The single adapter every AI call in this file goes through. Order:
//   1. free providers  → costs nothing
//   2. paid Haiku      → only for subscribers/owner (or if PAID_FOR_TRIAL is on)
//                        and only while the daily ceiling has room
// It never silently falls back to the paid model for someone who is not
// entitled to it: that was the old behaviour, and it billed for every call.
const ai = {
  messages: {
    create: async (rawOpts) => {
      const ctx = reqCtx.getStore() ?? {};
      const opts = withLangDirective(rawOpts, ctx.lang ?? 'en');

      const free = await tryFreeProviders(opts);
      if (free.ok) {
        ctx.provider = free.provider;
        return { content: [{ text: free.text }] };
      }

      // Everyone may fall back to the paid model, because a broken app earns
      // nothing — but for anyone who is not a subscriber that fallback is
      // strictly bounded by the daily ceiling checked immediately below. The
      // protection is the ceiling, not a refusal that leaves users stuck.
      const entitledToPaid = ctx.isPro || ctx.isOwner || PAID_FOR_TRIAL;
      if (!entitledToPaid) {
        throw new AiUnavailable(
          'The free AI service is temporarily unavailable. Please try again in a few minutes.',
          free.errors
        );
      }

      const unlimited = ctx.isPro || ctx.isOwner;
      const cap = await canSpend(unlimited, ctx.userId);
      if (!cap.allowed) {
        console.error('[SPEND] daily ceiling reached — refusing paid call', cap);
        throw new AiUnavailable(MSG.BUSY, cap);
      }

      const resp = await anthropic.messages.create(opts);
      ctx.provider = 'haiku(paid)';
      ctx.costCents = await recordSpend(resp.usage, unlimited, ctx.userId);
      return resp;
    },
  },
};

// ── User-facing copy ──────────────────────────────────────────
// Every refusal names the reason, stays warm, and offers the way out. The app
// shows its OWN translated text keyed on `code` (EN/DE/ES/FR) — these strings
// are the fallback for an app version that does not know the code yet, so they
// must still read well on their own.
const MSG = {
  SIGN_IN_REQUIRED: 'Oops — you need a free account to continue. It takes a few seconds and starts your 7-day free trial.',
  SESSION_EXPIRED:  'Oops — your session has expired. Please sign in again to continue.',
  TRIAL_EXPIRED:    'Your 7-day free trial has ended. Your recipes are safe — subscribe to unlock them and keep cooking.',
  EMAIL_UNVERIFIED: 'Please confirm your email address to start your 7-day free trial. Check your inbox for the link we sent you.',
  QUOTA_IMPORT:     "You have reached today's import limit. Your allowance refreshes at midnight — or go Premium for unlimited imports right now.",
  QUOTA_AI:         "You have reached today's Smart Chef limit. Your allowance refreshes at midnight — or go Premium for unlimited access right now.",
  TOO_FAST:         'Oops — that is a lot of requests at once. Please wait a moment and try again. Premium members enjoy a smoother, unlimited experience.',
  BUSY:             'Oops — Recipe Haven is unusually busy right now. Please try again a little later, or upgrade to Premium for priority access.',
};

// ── Step 1: who is calling? ───────────────────────────────────
// Runs BEFORE any limit is applied, because the limits must not touch paying
// members. Verifies the Supabase access token and loads the entitlement flags.
// Fails OPEN when Supabase is not configured, so an incomplete deploy can
// never take the live app down.
async function resolveUser(req, res, next) {
  if (!db) return next();

  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    // No account. Allowed through only while REQUIRE_ACCOUNT is off, and only
    // ever served by the free providers — a signed-out visitor can never cause
    // a paid API call.
    if (REQUIRE_ACCOUNT) {
      return res.status(401).json({ code: 'SIGN_IN_REQUIRED', error: MSG.SIGN_IN_REQUIRED });
    }
    req.userId = null; req.isPro = false; req.isOwner = false;
    return next();
  }

  let user;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ code: 'SESSION_EXPIRED', error: MSG.SESSION_EXPIRED });
    }
    user = data.user;
  } catch (e) {
    console.error('[AUTH] token check failed:', e.message);
    return res.status(401).json({ code: 'SESSION_EXPIRED', error: MSG.SESSION_EXPIRED });
  }

  // A trial is worth exactly as much as the identity behind it. Without this,
  // anyone types a made-up address, burns the trial, and types another one —
  // unlimited trials, all paid for by us. Requiring a confirmed address means
  // each trial costs the abuser a real, working inbox.
  // Social sign-ins (Apple, Google) arrive already confirmed by the provider.
  if (REQUIRE_VERIFIED_EMAIL && !user.email_confirmed_at && !user.confirmed_at) {
    return res.status(403).json({ code: 'EMAIL_UNVERIFIED', error: MSG.EMAIL_UNVERIFIED });
  }

  const { data: prof } = await db
    .from('profiles')
    .select('is_pro, pro_expires_at, is_owner')
    .eq('id', user.id)
    .maybeSingle();

  const proActive = !!prof?.is_pro && (!prof.pro_expires_at || new Date(prof.pro_expires_at) > new Date());

  // Read by the rate limiters' skip() and by the AI adapter.
  req.userId  = user.id;
  req.isPro   = proActive;
  req.isOwner = !!prof?.is_owner;

  const ctxStore = reqCtx.getStore();
  if (ctxStore) {
    ctxStore.userId  = user.id;
    ctxStore.isPro   = proActive;
    ctxStore.isOwner = req.isOwner;
  }
  next();
}

// Paying members and the owner bypass every product limit. Used by both rate
// limiters and by the quota gate, so there is one definition of "unlimited".
const isUnlimited = (req) => req.isPro === true || req.isOwner === true;

// ── Step 2: spend one unit of the trial budget ────────────────
// Only ever reached by non-paying accounts. The counter lives in the database,
// so deleting and reinstalling the app does not reset it.
function consumeQuota(kind) {
  return async (req, res, next) => {
    if (!db) return next();
    if (isUnlimited(req)) return next();
    // Signed-out visitor (only possible while REQUIRE_ACCOUNT is off). There is
    // no account to meter, and they cost nothing because they are restricted to
    // the free providers.
    if (!req.userId) return next();

    const { data: q, error: qErr } = await db.rpc('consume_quota', {
      p_user: req.userId,
      p_kind: kind,
      p_trial_days: TRIAL_DAYS,
      p_import_max: TRIAL_IMPORTS,
      p_ai_max: TRIAL_AI_USES,
    });

    if (qErr) {
      // This table is what protects the bill. If it cannot be read, refuse
      // rather than wave the request through.
      console.error('[TRIAL] consume_quota failed:', qErr.message);
      return res.status(503).json({ code: 'UNAVAILABLE', error: MSG.BUSY });
    }

    if (!q?.allowed) {
      if (q?.reason === 'trial_expired') {
        return res.status(402).json({ code: 'TRIAL_EXPIRED', error: MSG.TRIAL_EXPIRED, daysLeft: 0 });
      }
      // resetsAt lets the app show a live countdown ("back in 4h 12m") instead
      // of a dead end. Running out for today is a pause, and it has to read
      // like one — a user who feels punished uninstalls.
      return res.status(402).json({
        code: 'QUOTA_EXHAUSTED',
        kind,
        used: q?.used ?? 0,
        cap: q?.cap ?? 0,
        daysLeft: q?.days_left ?? 0,
        resetsAt: q?.resets_at ?? null,
        error: kind === 'import' ? MSG.QUOTA_IMPORT : MSG.QUOTA_AI,
      });
    }

    const ctxStore = reqCtx.getStore();
    if (ctxStore) ctxStore.quota = q;
    next();
  };
}

// ── Rate limiting (anti-abuse / anti-cost-blowup) ──────────────
// The AI + import endpoints each call Anthropic and cost money, so they are
// capped tightly. /health is intentionally NOT limited (cron keep-alive pings).
const jsonMessage = (code, msg) => ({
  windowMs: 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code, error: msg },
});

// Raw flood guard. Applies to everyone, paying members included, because it is
// denial-of-service protection rather than a product limit: 60/minute is far
// beyond anything a person tapping through a recipe app can reach, so a
// subscriber will never meet it.
const floodLimiter = rateLimit({ ...jsonMessage('TOO_FAST', MSG.TOO_FAST), max: 60 });

// Product limit for accounts on the free trial. 3/minute is generous for a
// human (each call takes seconds to return and produces a recipe to read) and
// useless to a script. PAYING MEMBERS AND THE OWNER SKIP THIS ENTIRELY — that
// is what skip() below guarantees.
const aiLimiter = rateLimit({
  ...jsonMessage('TOO_FAST', MSG.TOO_FAST),
  max: 3,
  skip: (req) => isUnlimited(req),
});

// ORDER MATTERS, and it is the whole point of this block:
//   1. prove the caller is the app
//   2. work out WHO is calling — before any limit is applied
//   3. only then apply limits, which paying members skip
//   4. only then spend trial credit, which paying members never touch
app.use('/api/import/', requireAppSecret, resolveUser);
app.use('/api/ai/',     requireAppSecret, resolveUser);

app.use('/api/', floodLimiter);          // safety net on every API route

app.use('/api/import/', aiLimiter, consumeQuota('import'));
app.use('/api/ai/',     aiLimiter, consumeQuota('ai'));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Diagnostics ───────────────────────────────────────────────
// Open this in a browser to SEE, rather than assume:
//   https://<your-server>/api/diag?key=<APP_SECRET>
// It actually calls each free provider with a one-word prompt and prints the
// real error when one fails, and shows what the paid model has cost today.
// This exists because the old code hid provider failures in a console warning
// nobody reads, and quietly billed the paid model instead.
app.get('/api/diag', async (req, res) => {
  if (APP_SECRET && req.query.key !== APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  // The budget must be realistic: thinking-capable models spend part of it
  // before writing anything, so a tiny probe reports a false failure.
  const probe = { max_tokens: 800, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] };
  const providers = [];

  for (const p of (USE_FREE_PROVIDERS ? freeProviders(false) : [])) {
    const started = Date.now();
    try {
      const text = await callOpenAICompatible(p, probe);
      providers.push({ name: p.name, model: p.model, ok: true, ms: Date.now() - started, sample: text.slice(0, 40) });
    } catch (e) {
      providers.push({ name: p.name, model: p.model, ok: false, ms: Date.now() - started, error: e.message });
    }
  }

  if (USE_FREE_PROVIDERS && GEMINI_KEY) {
    const started = Date.now();
    try {
      const text = await callGemini(probe);
      providers.push({ name: 'gemini', model: GEMINI_MODEL, ok: true, ms: Date.now() - started, sample: text.slice(0, 40) });
    } catch (e) {
      providers.push({ name: 'gemini', model: GEMINI_MODEL, ok: false, ms: Date.now() - started, error: e.message });
    }
  }

  let spend = { note: 'Supabase not configured — spend is NOT being tracked.' };
  if (db) {
    const { data, error } = await db.rpc('can_spend', { p_cap_cents: DAILY_CAP_CENTS });
    spend = error ? { error: error.message } : data;
  }

  const anyFreeWorks = providers.some((p) => p.ok);
  res.json({
    config: {
      supabaseConfigured: !!db,
      appSecretSet: !!APP_SECRET,
      anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
      useFreeProviders: USE_FREE_PROVIDERS,
      requireAccount: REQUIRE_ACCOUNT,
      requireVerifiedEmail: REQUIRE_VERIFIED_EMAIL,
      trialDays: TRIAL_DAYS,
      trialImports: TRIAL_IMPORTS,
      trialAiUses: TRIAL_AI_USES,
      dailyCapCents: DAILY_CAP_CENTS,
      dailyCapProCents: DAILY_CAP_PRO_CENTS,
      paidForTrial: PAID_FOR_TRIAL,
    },
    freeProviders: USE_FREE_PROVIDERS
      ? (providers.length ? providers : 'Enabled, but no provider key is set.')
      : 'DISABLED (USE_FREE_PROVIDERS is not true) — every call goes to the paid model.',
    spendToday: spend,
    verdict: !USE_FREE_PROVIDERS
      ? `Paid model only. Non-subscribers share one pool of ${DAILY_CAP_CENTS}c/day; each subscriber has their own separate ${DAILY_CAP_PRO_CENTS}c/day and can never be blocked by anyone else's usage.`
      : anyFreeWorks
        ? 'A free provider works. Set PAID_FOR_TRIAL=false to stop paying for non-subscribers entirely.'
        : 'Free providers are ENABLED but none is answering — every call is falling through to the paid model after a delay. Set USE_FREE_PROVIDERS=false to remove that delay.',
  });
});

// ── RevenueCat webhook ────────────────────────────────────────
// The ONLY thing allowed to mark an account as paying. The app must never be
// trusted for this: a modified client could otherwise just claim to be Pro.
// Set up in RevenueCat → Integrations → Webhooks:
//   URL:            https://<your-server>/webhooks/revenuecat
//   Authorization:  the value of REVENUECAT_WEBHOOK_SECRET
// Requires the app to call Purchases.logIn(<supabase user id>) so app_user_id
// matches the profiles row.
app.post('/webhooks/revenuecat', async (req, res) => {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (secret && req.get('authorization') !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  if (!db) return res.status(200).json({ ok: true, note: 'Supabase not configured; ignored.' });

  const event = req.body?.event ?? {};
  const uid = event.app_user_id;
  const type = String(event.type ?? '');
  if (!uid) return res.status(200).json({ ok: true, note: 'No app_user_id; ignored.' });

  // Anything that grants or extends access carries an expiry; anything that
  // removes it does not. Expiry is checked on every request, so a cancellation
  // that still has paid time left keeps working until it actually runs out.
  const GRANTS = ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE'];
  const REVOKES = ['EXPIRATION', 'REFUND'];

  let patch = null;
  if (GRANTS.includes(type)) {
    patch = {
      is_pro: true,
      pro_expires_at: event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null,
    };
  } else if (REVOKES.includes(type)) {
    patch = { is_pro: false, pro_expires_at: null };
  }

  if (patch) {
    const { error } = await db.from('profiles').update(patch).eq('id', uid);
    if (error) console.error('[RC] profile update failed:', error.message);
    else console.log(`[RC] ${type} → ${uid} is_pro=${patch.is_pro}`);
  }
  res.status(200).json({ ok: true });
});

// Extract recipe from URL (web or social)
app.post('/api/import/url', requireAppSecret, async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Repair typos mobile keyboards inject into pasted links:
  // "www domain.com" (space instead of dot), "site . com", or a URL buried in shared text.
  url = String(url).trim().replace(/^((?:https?:\/\/)?www)\s+/i, '$1.');
  const embedded = url.match(/https?:\/\/\S+/i);
  if (embedded) {
    url = embedded[0];
  } else {
    url = url.replace(/\s*\.\s*/g, '.');
    url = url.split(/\s+/).find((p) => p.includes('.')) || url;
  }

  // Add https:// if missing
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // Validate before fetching so the user gets a clear message, not a raw parse error
  try { new URL(url); } catch {
    return res.status(422).json({ error: 'This link looks invalid. Copy the URL again from your browser or the app, then paste it here.' });
  }

  // Detect platforms
  const isPinterest = /pinterest\.(com|fr|de|co\.uk|ca|com\.au)|pin\.it/i.test(url);
  const isYouTube   = /youtube\.com|youtu\.be/i.test(url);
  const isInstagram = /instagram\.com\/(p|reel|tv)\//i.test(url);
  const isTikTok    = /tiktok\.com/i.test(url);
  const isFacebook  = /facebook\.com\/(?!groups|events)|fb\.watch|fb\.com/i.test(url);

  const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
  };

  try {
    let fetchUrl = url;

    // Pinterest: fetch the pin page and extract the source URL from their JSON data
    if (isPinterest) {
      try {
        const pinRes = await fetch(url, {
          headers: BROWSER_HEADERS,
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        const pinHtml = await pinRes.text();

        // Pinterest stores the external recipe URL in "link":"..." inside their embedded JSON
        // The URL may contain unicode-escaped slashes (/ = /)
        let sourceUrl = null;
        const candidates = [
          ...pinHtml.matchAll(/"link":"(https?:[^"\\]*(?:\\.[^"\\]*)*)"/g),
          ...pinHtml.matchAll(/property="og:see_also"\s+content="([^"]+)"/gi),
          ...pinHtml.matchAll(/content="([^"]+)"\s+property="og:see_also"/gi),
        ];

        for (const match of candidates) {
          const decoded = match[1]
            .replace(/\\u002F/gi, '/')
            .replace(/\\u003A/gi, ':')
            .replace(/\\\//g, '/')
            .trim();
          if (decoded.startsWith('http') && !/pinterest\./i.test(decoded)) {
            sourceUrl = decoded;
            break;
          }
        }

        if (sourceUrl) {
          fetchUrl = sourceUrl;
        } else {
          return res.status(422).json({
            error: 'This Pinterest pin has no external recipe link. Open the pin on Pinterest, tap the website link below the image, and paste that URL here.',
          });
        }
      } catch (err) {
        return res.status(422).json({
          error: 'Could not read this Pinterest pin. Try pasting the recipe website URL directly.',
        });
      }
    }

    // Instagram: use public embed endpoint to get caption (no login needed for public posts)
    if (isInstagram) {
      const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
      if (!match) return res.status(422).json({ error: 'Invalid Instagram URL. Copy the link directly from the post.' });
      const code = match[1];
      try {
        // Instagram serves reels and posts under different embed paths, and it
        // increasingly answers datacenter IPs with a login wall instead of the
        // caption. Try every known embed shape before giving up, and keep the
        // longest usable body — one of them usually still carries the caption.
        const embedUrls = [
          `https://www.instagram.com/reel/${code}/embed/captioned/`,
          `https://www.instagram.com/p/${code}/embed/captioned/`,
          `https://www.instagram.com/reel/${code}/embed/`,
          `https://www.instagram.com/p/${code}/embed/`,
        ];
        let embedText = '';
        for (const embedUrl of embedUrls) {
          try {
            const embedRes = await fetch(embedUrl, {
              headers: BROWSER_HEADERS,
              signal: AbortSignal.timeout(12000),
            });
            if (!embedRes.ok) continue;
            const embedHtml = await embedRes.text();
            const text = embedHtml
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ').trim().slice(0, 8000);
            if (text.length > embedText.length) embedText = text;
            // A caption-bearing page is comfortably longer than the login wall.
            if (embedText.length >= 400) break;
          } catch { /* try the next shape */ }
        }
        if (embedText.length < 100) {
          // Instagram blocks datacenter IPs, so link import fails for most
          // posts however many embed shapes we try. Point the user at the
          // camera scan instead — screenshotting the caption always works.
          return res.status(422).json({ error: 'Instagram blocks apps from reading its posts. Here is what works: screenshot the post with its caption visible, then use Scan Recipe on that screenshot — it extracts the recipe perfectly.' });
        }
        const igResp = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
          messages: [{ role: 'user', content: `Extract the recipe from this Instagram post caption.\nReturn JSON: {"title":string,"servings":number,"time":string|null,"ingredients":[{"qty":string,"name":string}],"instructions":[string]}\nIf no recipe: {"error":"No recipe in this post"}\n\nPost:\n${embedText}\n\nReturn ONLY valid JSON.` }],
        });
        const raw = igResp.content[0].text?.trim() ?? '';
        let recipe; try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Could not parse response.' }); recipe = JSON.parse(m[0]); }
        if (recipe.error) return res.status(422).json({ error: recipe.error });
        return res.json(recipe);
      } catch {
        return res.status(422).json({ error: 'Instagram blocks apps from reading its posts. Here is what works: screenshot the post with its caption visible, then use Scan Recipe on that screenshot — it extracts the recipe perfectly.' });
      }
    }

    // TikTok: use official oEmbed API (free, no auth needed)
    if (isTikTok) {
      try {
        let caption = '';
        let oData = {};
        try {
          const oRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
            headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000),
          });
          oData = await oRes.json();
          caption = oData.title || '';
        } catch { /* fall through to page scrape */ }

        // Fallback: read the video page itself and pull the description from its JSON
        if (caption.length < 20) {
          try {
            const tRes = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
            const tHtml = await tRes.text();
            const dMatch = tHtml.match(/"desc":"((?:[^"\\]|\\.)*)"/);
            if (dMatch) {
              const pageDesc = dMatch[1]
                .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
              if (pageDesc.length > caption.length) caption = pageDesc;
            }
          } catch { /* keep whatever oEmbed gave us */ }
        }

        if (caption.length < 20) return res.status(422).json({ error: 'This TikTok has no recipe in the caption. The creator may have put the recipe in a comment.' });
        const ttResp = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
          messages: [{ role: 'user', content: `Extract the recipe from this TikTok caption.\nReturn JSON: {"title":string,"servings":number,"time":string|null,"ingredients":[{"qty":string,"name":string}],"instructions":[string]}\nIf no recipe: {"error":"No recipe in this TikTok"}\n\nCaption:\n${caption}\n\nReturn ONLY valid JSON.` }],
        });
        const raw = ttResp.content[0].text?.trim() ?? '';
        let recipe; try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Could not parse response.' }); recipe = JSON.parse(m[0]); }
        if (recipe.error) return res.status(422).json({ error: recipe.error });
        if (oData.thumbnail_url && !recipe.imageUrl) recipe.imageUrl = oData.thumbnail_url;
        return res.json(recipe);
      } catch {
        return res.status(422).json({ error: 'Could not read this TikTok. Make sure the video is public.' });
      }
    }

    // Facebook: use public post embed
    if (isFacebook) {
      try {
        const fbEmbed = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(url)}&width=500`;
        const fbRes = await fetch(fbEmbed, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(12000) });
        const fbHtml = await fbRes.text();
        const fbText = fbHtml
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ').trim().slice(0, 8000);
        if (fbText.length < 100) return res.status(422).json({ error: 'Could not read this Facebook post. Make sure it is public.' });
        const fbResp = await ai.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 2000,
          messages: [{ role: 'user', content: `Extract the recipe from this Facebook post.\nReturn JSON: {"title":string,"servings":number,"time":string|null,"ingredients":[{"qty":string,"name":string}],"instructions":[string]}\nIf no recipe: {"error":"No recipe in this post"}\n\nPost:\n${fbText}\n\nReturn ONLY valid JSON.` }],
        });
        const raw = fbResp.content[0].text?.trim() ?? '';
        let recipe; try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Could not parse response.' }); recipe = JSON.parse(m[0]); }
        if (recipe.error) return res.status(422).json({ error: recipe.error });
        return res.json(recipe);
      } catch {
        return res.status(422).json({ error: 'Could not read this Facebook post. Make sure it is a public post.' });
      }
    }

    // YouTube: read the description (shortDescription field is reliable).
    // 1) try to extract a full recipe from the description text
    // 2) if none, follow a recipe-blog link found in the description
    if (isYouTube) {
      try {
        let desc = '';
        let thumb = null;

        const idMatch = url.match(/(?:youtube\.com\/(?:watch\?[^#]*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);

        // 1st source: official YouTube Data API — the ONLY method YouTube
        // guarantees from datacenter IPs (Render). Needs YOUTUBE_API_KEY env var.
        if (idMatch && process.env.YOUTUBE_API_KEY) {
          try {
            const aRes = await fetch(
              `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${idMatch[1]}&key=${process.env.YOUTUBE_API_KEY}`,
              { signal: AbortSignal.timeout(12000) }
            );
            const aData = await aRes.json();
            const sn = aData?.items?.[0]?.snippet;
            if (sn) {
              desc = sn.description || '';
              const t = sn.thumbnails;
              thumb = (t?.maxres || t?.high || t?.medium || t?.default)?.url || null;
            }
          } catch { /* fall through */ }
        }

        // 2nd source: YouTube's internal player API (works from residential IPs;
        // datacenter IPs are often blocked — try two client profiles).
        if (idMatch && !desc) {
          const clients = [
            { clientName: 'WEB', clientVersion: '2.20240726.00.00', hl: 'en' },
            { clientName: 'IOS', clientVersion: '19.45.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en' },
          ];
          for (const client of clients) {
            try {
              const pRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId: idMatch[1], context: { client } }),
                signal: AbortSignal.timeout(15000),
              });
              const pData = await pRes.json();
              desc = pData?.videoDetails?.shortDescription || '';
              const thumbs = pData?.videoDetails?.thumbnail?.thumbnails;
              if (!thumb && Array.isArray(thumbs) && thumbs.length) thumb = thumbs[thumbs.length - 1].url;
              if (desc) break;
            } catch { /* try next client */ }
          }
        }

        // 2nd source (fallback): scrape the watch page HTML
        if (!desc) {
          const ytRes = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20000) });
          const ytHtml = await ytRes.text();
          const descMatch = ytHtml.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
          if (descMatch) {
            desc = descMatch[1]
              .replace(/\\n/g, '\n').replace(/\\r/g, '')
              .replace(/\\"/g, '"').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
          }
          if (!thumb) {
            const ytImg = ytHtml.match(/"thumbnailUrl":"([^"]+)"/);
            thumb = ytImg ? ytImg[1].replace(/\\\//g, '/') : null;
          }
        }

        // 1) Recipe written directly in the description?
        if (desc.length > 80) {
          const ytPrompt = `Extract the recipe from this YouTube video description. Return JSON:\n{\n  "title": string,\n  "servings": number,\n  "time": string or null,\n  "ingredients": [{"qty": string, "name": string}],\n  "instructions": [string]\n}\nSucceed if the description contains at least a list of ingredients — many creators list ONLY ingredients and demonstrate the steps in the video.\n- If the description already contains preparation steps, extract them verbatim.\n- If the description has ingredients but NO written steps, WRITE clear, concise step-by-step instructions yourself based on the dish title and the ingredient list (use standard cooking technique for this dish). Produce a genuinely usable method (5-10 steps).\n- Never return an empty "instructions" array.\nOnly return {"error": "no inline recipe"} if there is no ingredient list at all.\n\nDescription:\n${desc.slice(0, 6000)}\n\nReturn ONLY valid JSON.`;
          const ytResp = await ai.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: ytPrompt }] });
          const raw = ytResp.content[0].text?.trim() ?? '';
          let recipe;
          try { recipe = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]+\}/); recipe = m ? JSON.parse(m[0]) : { error: 'parse' }; }
          if (!recipe.error) {
            if (thumb && !recipe.imageUrl) recipe.imageUrl = thumb;
            // Safety net: if the model still returned no steps, give a usable fallback.
            if (!Array.isArray(recipe.instructions) || recipe.instructions.length === 0) {
              recipe.instructions = ['Combine and prepare the ingredients above following standard method for this dish. Watch the original video for the exact technique.'];
            }
            return res.json(recipe);
          }
        }

        // 2) No inline recipe — find a recipe website link in the description and follow it
        const urls = desc.match(/https?:\/\/[^\s"'<>]+/g) || [];
        const blogUrl = urls.find((u) =>
          !/youtu\.?be|youtube\.com|google\.|amazon\.|instagram\.|tiktok\.|facebook\.|patreon\.|paypal\.|venmo\.|bit\.ly|linktr\.ee|twitter\.|x\.com|spotify\.|\/products?\/|\/shop\b|\/store\b|merch|etsy\.|discord\./i.test(u)
        );
        if (blogUrl) {
          fetchUrl = blogUrl.replace(/[).,]+$/, ''); // strip trailing punctuation, fall through to web extraction below
        } else {
          return res.status(422).json({ error: 'No recipe found for this video. The recipe is likely shown in the video itself, not written in the description.' });
        }
      } catch {
        return res.status(422).json({ error: 'Could not read this YouTube video. The server may be waking up — try again in 30 seconds.' });
      }
    }

    const pageRes = await fetch(fetchUrl, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(20000),
    });

    if (!pageRes.ok) {
      if (pageRes.status === 403 || pageRes.status === 401) {
        return res.status(422).json({ error: 'This website blocks automated access. Try copying the recipe text manually.' });
      }
      return res.status(422).json({ error: `Could not open this page (HTTP ${pageRes.status}). Check the URL and try again.` });
    }

    const html = await pageRes.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);

    if (text.length < 200) {
      return res.status(422).json({ error: 'This page requires a browser to load (JavaScript-only site). Try a different recipe URL.' });
    }

    const imgMatch = html.match(/property="og:image"\s+content="([^"]+)"/i)
      || html.match(/content="([^"]+)"\s+property="og:image"/i);
    const metaImage = imgMatch ? imgMatch[1] : null;

    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Extract the recipe from this webpage text. Return a JSON object with exactly these fields:\n{\n  "title": string,\n  "servings": number (default 2 if not found),\n  "time": string or null (e.g. "30 min"),\n  "ingredients": [{ "qty": string, "name": string }],\n  "instructions": [string] (each element is one step),\n  "imageUrl": string or null\n}\n\nIf there is no recipe in this text, return: {"error": "Not a recipe page"}\n\nWebpage text:\n${text}\n\nReturn ONLY valid JSON. No markdown fences.`,
        },
      ],
    });

    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try {
      recipe = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]+\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Could not read the AI response. Please try again.' });
      recipe = JSON.parse(jsonMatch[0]);
    }

    if (recipe.error) return res.status(422).json({ error: recipe.error });
    if (!recipe.imageUrl && metaImage) recipe.imageUrl = metaImage;

    res.json(recipe);
  } catch (err) {
    console.error('URL import error:', err);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(422).json({ error: 'The page took too long to load. Try again or use a different URL.' });
    }
    res.status(500).json({ error: `Import failed: ${err.message || 'Unknown error'}` });
  }
});

// Extract recipe from camera scan image (base64)
app.post('/api/import/scan', requireAppSecret, async (req, res) => {
  const { base64Image } = req.body;
  if (!base64Image) return res.status(400).json({ error: 'base64Image is required' });

  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image,
              },
            },
            {
              type: 'text',
              // Two very different jobs share this one endpoint:
              // CASE A — the image contains written recipe text (handwritten
              // card, cookbook page, a screenshot of a caption): transcribe it
              // faithfully, invent nothing.
              // CASE B — the image is just a photo of a finished dish with no
              // text: identify the dish and write a plausible recipe for it.
              // Case B must be flagged, because it is an approximation of the
              // dish, NOT the original recipe, and the user has to know that.
              text: `Look at this image and return a recipe as JSON.\n\nFIRST decide which case applies:\n\nCASE A — The image contains WRITTEN RECIPE TEXT (a handwritten card, a cookbook or magazine page, a screenshot of a post caption, a printed recipe).\n→ Transcribe that recipe exactly as written. Do not invent or embellish anything. Keep the original quantities and steps.\n→ Set "generated" to false.\n\nCASE B — The image shows only a PREPARED DISH or FOOD, with no readable recipe text.\n→ Identify the dish as precisely as you can from what you see, then write a realistic, practical recipe a home cook could follow to reproduce it. Use standard technique and sensible quantities for that dish.\n→ Set "generated" to true.\n→ Prefix the title with "Inspired by: " (for example "Inspired by: Glazed Meatloaf").\n\nReturn a JSON object with exactly these fields:\n{\n  "title": string,\n  "servings": number (default 4 if unknown),\n  "time": string or null (e.g. "45 min"),\n  "ingredients": [{ "qty": string, "name": string }],\n  "instructions": [string],\n  "generated": boolean\n}\n\nOnly return {"error": "No food or recipe found in image"} when the image contains neither readable recipe text NOR any identifiable food. Never return an error just because a dish photo has no written recipe — that is CASE B, so write the recipe.\n\nReturn ONLY valid JSON. No markdown fences.`,
            },
          ],
        },
      ],
    });

    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try {
      recipe = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/\{[\s\S]+\}/);
      if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse AI response' });
      recipe = JSON.parse(jsonMatch[0]);
    }

    if (recipe.error) return res.status(422).json({ error: recipe.error });
    res.json(recipe);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Failed to scan recipe. Check server logs.' });
  }
});

// AI Tool 1: What's in my fridge?
app.post('/api/ai/fridge', requireAppSecret, async (req, res) => {
  const { ingredients } = req.body;
  if (!ingredients) return res.status(400).json({ error: 'ingredients is required' });
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Create a delicious recipe using these ingredients: ${ingredients}

Return a JSON object with exactly these fields:
{
  "title": string,
  "servings": number,
  "time": string,
  "ingredients": [{ "qty": string, "name": string }],
  "instructions": [string]
}

Be creative but practical. Return ONLY valid JSON. No markdown fences.`,
      }],
    });
    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try { recipe = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Failed to parse AI response' }); recipe = JSON.parse(m[0]); }
    res.json(recipe);
  } catch (err) {
    console.error('Fridge AI error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

// AI Tool 2: Transform Leftovers
app.post('/api/ai/leftovers', requireAppSecret, async (req, res) => {
  const { meal } = req.body;
  if (!meal) return res.status(400).json({ error: 'meal is required' });
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `I have leftovers from: ${meal}

Create a completely different, creative recipe that transforms these leftovers into a new dish.

Return a JSON object with exactly these fields:
{
  "title": string,
  "servings": number,
  "time": string,
  "ingredients": [{ "qty": string, "name": string }],
  "instructions": [string]
}

Return ONLY valid JSON. No markdown fences.`,
      }],
    });
    const raw = response.content[0].text?.trim() ?? '';
    let recipe;
    try { recipe = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Failed to parse AI response' }); recipe = JSON.parse(m[0]); }
    res.json(recipe);
  } catch (err) {
    console.error('Leftovers AI error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

// AI Tool 3: Chef S.O.S Chat
app.post('/api/ai/chat', requireAppSecret, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: 'You are an expert chef and cooking assistant. Answer cooking questions helpfully and concisely. Focus on practical advice.',
      messages: [{ role: 'user', content: message }],
    });
    res.json({ reply: response.content[0].text?.trim() ?? '' });
  } catch (err) {
    console.error('Chat AI error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

// AI Tool 4: Make it Healthier
app.post('/api/ai/healthify', requireAppSecret, async (req, res) => {
  const { ingredients, title } = req.body;
  if (!ingredients) return res.status(400).json({ error: 'ingredients is required' });
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Make this recipe healthier by suggesting ingredient substitutions.

Recipe: ${title || 'Recipe'}
Ingredients: ${ingredients}

Return a JSON object with exactly this structure:
{
  "substitutions": [
    { "original": string, "replacement": string, "reason": string }
  ]
}

Suggest 3-5 meaningful substitutions that reduce calories, sugar, or saturated fat, or increase nutritional value. Only suggest substitutions that make practical sense for this recipe. Be specific.

Return ONLY valid JSON. No markdown fences.`,
      }],
    });
    const raw = response.content[0].text?.trim() ?? '';
    let result;
    try { result = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]+\}/); if (!m) return res.status(500).json({ error: 'Failed to parse AI response' }); result = JSON.parse(m[0]); }
    res.json(result);
  } catch (err) {
    console.error('Healthify error:', err);
    res.status(500).json({ error: 'AI request failed.' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ RecipeSnap server running on port ${PORT}`);
  console.log(`   Health:     http://localhost:${PORT}/health`);
  console.log(`   URL import: POST http://localhost:${PORT}/api/import/url`);
  console.log(`   Scan:       POST http://localhost:${PORT}/api/import/scan`);
  console.log(`   AI Fridge:  POST http://localhost:${PORT}/api/ai/fridge`);
  console.log(`   AI Leftov:  POST http://localhost:${PORT}/api/ai/leftovers`);
  console.log(`   AI Chat:    POST http://localhost:${PORT}/api/ai/chat\n`);
});
