#!/usr/bin/env node
/**
 * Transcribe ONE audio file with two providers and print both results.
 *
 * Exists because the code-switching evidence available publicly is for
 * Urdu-English, not Malayalam-English. Rather than pick a speech-to-text model
 * on the strength of a paper about a different language pair, run the real
 * audio through both and read the transcripts.
 *
 * Usage:
 *   node scripts/compare-transcription.js <path-to-audio.mp3>
 *
 * Reads the repo-root .env. Costs a few cents per run.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const audioPath = process.argv[2];
if (!audioPath || !fs.existsSync(audioPath)) {
  console.error('Usage: node scripts/compare-transcription.js <path-to-audio>');
  console.error('Tip: the pipeline leaves extracted audio in apps/integration-service/downloads/audio/');
  process.exit(1);
}

const sizeMb = fs.statSync(audioPath).size / (1024 * 1024);
console.log(`Audio: ${path.basename(audioPath)}  (${sizeMb.toFixed(1)} MB)\n`);

/** Whisper-style multipart upload against any OpenAI-compatible endpoint. */
async function transcribeOpenAiCompatible({ label, baseUrl, apiKey, model }) {
  if (!apiKey) return { label, skipped: 'no API key configured' };
  const started = Date.now();
  try {
    const form = new FormData();
    form.append('model', model);
    form.append('file', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));

    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = await res.text();
    if (!res.ok) return { label, model, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    const json = JSON.parse(body);
    return { label, model, text: json.text ?? '', seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    return { label, model, error: err.message };
  }
}

/** Gemini takes the audio inline and is asked to preserve both scripts. */
async function transcribeGemini({ apiKey, model }) {
  if (!apiKey) return { label: 'Gemini', skipped: 'GEMINI_API_KEY not set' };
  const started = Date.now();
  try {
    const b64 = fs.readFileSync(audioPath).toString('base64');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text:
                  'Transcribe this 1:1 class recording verbatim. The speakers mix English and ' +
                  'Malayalam freely. Keep English words in Latin script and Malayalam in Malayalam ' +
                  'script exactly as spoken — do NOT translate or transliterate either one. ' +
                  'Output only the transcript.' },
              { inline_data: { mime_type: 'audio/mpeg', data: b64 } },
            ],
          }],
        }),
      }
    );
    const body = await res.text();
    if (!res.ok) return { label: 'Gemini', model, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    const json = JSON.parse(body);
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
    return { label: 'Gemini', model, text, seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    return { label: 'Gemini', model, error: err.message };
  }
}

/** What fraction of the text is Malayalam vs Latin — the tell for transliteration. */
function scriptMix(text) {
  const malayalam = (text.match(/[\u0D00-\u0D7F]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const total = malayalam + latin;
  if (total === 0) return 'no script detected';
  return `${Math.round((latin / total) * 100)}% Latin / ${Math.round((malayalam / total) * 100)}% Malayalam`;
}

(async () => {
  const results = [];

  results.push(await transcribeOpenAiCompatible({
    label: 'Groq Whisper',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo',
  }));

  if (process.env.OPENROUTER_API_KEY) {
    results.push(await transcribeOpenAiCompatible({
      label: 'OpenRouter GPT-4o Transcribe',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      model: 'openai/gpt-4o-transcribe',
    }));
  }

  results.push(await transcribeGemini({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-2.5-flash',
  }));

  for (const r of results) {
    console.log('='.repeat(78));
    console.log(`${r.label}${r.model ? `  [${r.model}]` : ''}`);
    console.log('='.repeat(78));
    if (r.skipped) { console.log(`SKIPPED — ${r.skipped}\n`); continue; }
    if (r.error)   { console.log(`FAILED — ${r.error}\n`); continue; }

    console.log(`took ${r.seconds.toFixed(1)}s · ${r.text.length.toLocaleString()} chars · ${scriptMix(r.text)}\n`);
    console.log(r.text.slice(0, 1500));
    if (r.text.length > 1500) console.log(`\n... [${(r.text.length - 1500).toLocaleString()} more chars]`);
    console.log();

    const out = path.join(__dirname, `transcript-${r.label.replace(/\W+/g, '-').toLowerCase()}.txt`);
    fs.writeFileSync(out, r.text);
    console.log(`full transcript -> ${out}\n`);
  }

  console.log('WHAT TO LOOK FOR');
  console.log('-'.repeat(78));
  console.log('1. Are English terms ("unit cost", "FOBO", "budget") in LATIN script,');
  console.log('   or transliterated into Malayalam? Transliteration is the failure mode.');
  console.log('2. Does the script mix roughly match how the class was actually taught?');
  console.log('3. Is the Malayalam readable, or word-salad?');
  console.log('\nThe transcript that keeps both scripts intact is the one to use.');
})();
