#!/usr/bin/env node
/**
 * Verify the AI provider configuration, and optionally prove it works.
 *
 *   node scripts/check-ai-config.js          # config only, no network
 *   node scripts/check-ai-config.js --live   # also send one tiny real request
 *
 * Written because a commented-out line in .env looks identical to a configured
 * one at a glance, and the symptom of getting it wrong is "it still takes 17
 * minutes" rather than an error.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const live = process.argv.includes('--live');
const mask = (v) => (!v ? null : v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : '(too short?)');
const pick = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === 'string' && v.trim()) return { value: v.trim(), from: n };
  }
  return { value: null, from: null };
};

const DEFAULT_BASE = 'https://api.groq.com/openai/v1';

const analysis = {
  base:  pick('AI_ANALYSIS_BASE_URL', 'AI_BASE_URL'),
  key:   pick('AI_ANALYSIS_API_KEY', 'AI_API_KEY', 'GROQ_API_KEY'),
  model: pick('AI_ANALYSIS_MODEL', 'GROQ_SUMMARY_MODEL'),
};
const stt = {
  base:  pick('AI_TRANSCRIPTION_BASE_URL', 'AI_BASE_URL'),
  key:   pick('AI_TRANSCRIPTION_API_KEY', 'AI_API_KEY', 'GROQ_API_KEY'),
  model: pick('AI_TRANSCRIPTION_MODEL', 'GROQ_TRANSCRIPTION_MODEL'),
};

const show = (title, cfg, fallbackModel) => {
  const base = cfg.base.value ?? DEFAULT_BASE;
  const vendor = base.includes('openrouter.ai') ? 'OpenRouter'
               : base.includes('groq.com')      ? 'Groq'
               : base.includes('googleapis')    ? 'Gemini' : base;
  console.log(`\n${title}`);
  console.log('  provider :', vendor, cfg.base.from ? `(via ${cfg.base.from})` : '(default)');
  console.log('  base url :', base);
  console.log('  model    :', cfg.model.value ?? `${fallbackModel}  (default)`);
  console.log('  api key  :', mask(cfg.key.value) ?? 'MISSING', cfg.key.from ? `(via ${cfg.key.from})` : '');
  return { base, vendor, key: cfg.key.value, model: cfg.model.value ?? fallbackModel };
};

console.log('='.repeat(70));
console.log('AI CONFIGURATION');
console.log('='.repeat(70));
const a = show('ANALYSIS  (the session report)', analysis, 'openai/gpt-oss-120b');
const t = show('TRANSCRIPTION  (speech to text)', stt, 'whisper-large-v3-turbo');

console.log('\nOTHER');
console.log('  GROQ_MAX_REQUEST_TOKENS :', process.env.GROQ_MAX_REQUEST_TOKENS ?? '(unset -> 0)');
console.log('  AI_REQUIRE_ZDR          :', process.env.AI_REQUIRE_ZDR ?? '(unset -> true)');

console.log('\n' + '='.repeat(70));
console.log('VERDICT');
console.log('='.repeat(70));

const problems = [];
if (!a.key) problems.push('Analysis has NO API key.');
if (!t.key) problems.push('Transcription has NO API key.');

if (a.vendor === 'Groq') {
  problems.push(
    'Analysis is still on GROQ. On the free tier that means 8,000 tokens/min,\n' +
    '  which forces the multi-pass workaround (~11 min of forced waiting for a\n' +
    '  90-minute class). Uncomment AI_ANALYSIS_BASE_URL / _API_KEY / _MODEL.'
  );
}
if (a.vendor === 'OpenRouter' && Number(process.env.GROQ_MAX_REQUEST_TOKENS ?? 0) > 0) {
  problems.push(
    'GROQ_MAX_REQUEST_TOKENS is still set. Analysis is on OpenRouter now, which\n' +
    '  has no 8k/min ceiling — set it to 0 so the whole class goes in ONE request\n' +
    '  instead of being split into paced passes for no reason.'
  );
}
if (a.vendor === 'OpenRouter' && a.key && !a.key.startsWith('sk-or-')) {
  problems.push(`Analysis key does not look like an OpenRouter key (expected "sk-or-…").`);
}

if (problems.length === 0) console.log('OK — analysis and transcription are both configured.');
else problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));

if (!live) {
  console.log('\nRun with --live to send one tiny real request and confirm the key works.');
  process.exit(problems.length ? 1 : 0);
}

(async () => {
  console.log('\n' + '='.repeat(70));
  console.log('LIVE CHECK  (one ~20-token request)');
  console.log('='.repeat(70));
  if (!a.key) { console.log('Skipped — no analysis API key.'); process.exit(1); }

  const headers = { Authorization: `Bearer ${a.key}`, 'Content-Type': 'application/json' };
  const body = {
    model: a.model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 10,
  };
  if (a.vendor === 'OpenRouter') {
    headers['HTTP-Referer'] = process.env.AI_APP_URL || 'https://app.finquo.ai';
    headers['X-Title'] = process.env.AI_APP_NAME || 'FINQUO Junior';
    if (process.env.AI_REQUIRE_ZDR !== 'false') {
      body.provider = { zdr: true, data_collection: 'deny' };
    }
  }

  try {
    const started = Date.now();
    const res = await fetch(`${a.base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      console.log(`FAILED — HTTP ${res.status}`);
      console.log(text.slice(0, 500));
      if (res.status === 401) console.log('\n-> the key is wrong, revoked, or has no credit.');
      if (res.status === 404) console.log(`\n-> "${a.model}" is not a valid slug on this provider.`);
      if (/zdr|data_collection|no endpoints/i.test(text)) {
        console.log('\n-> No Zero-Data-Retention endpoint serves this model. Either pick a');
        console.log('   different model, or set AI_REQUIRE_ZDR=false — but understand that');
        console.log('   means class recordings may be retained by the downstream provider.');
      }
      process.exit(1);
    }
    const json = JSON.parse(text);
    console.log('OK —', ((Date.now() - started) / 1000).toFixed(1) + 's');
    console.log('  replied :', JSON.stringify(json?.choices?.[0]?.message?.content ?? '(empty)'));
    console.log('  served  :', json?.provider ?? json?.model ?? '(not reported)');
  } catch (err) {
    console.log('FAILED —', err.message);
    process.exit(1);
  }
})();
