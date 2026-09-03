/**
 * Self-check for the Malayalam-class word-cloud supplement. Run:
 *   npx ts-node --transpile-only apps/learning-service/src/modules/transcription/cloud-supplement.check.ts
 * Pure logic — no model call, no network.
 */
import assert from 'assert';
import { GroqTranscriptionService } from './groq-transcription.service';

const { indicShare, pickSupplementWords } = GroqTranscriptionService as any;

// ── Language detection ────────────────────────────────────────────────────
assert.strictEqual(indicShare('hello money plan'), 0, 'pure English: zero');
assert.ok(indicShare('പണം എങ്ങനെ ചെലവാക്കാം money') > 0.5, 'mostly Malayalam: high');
assert.strictEqual(indicShare('!!! 123 ...'), 0, 'no letters at all: zero, not NaN');

// ── Supplement filter: the model can only add clean, new, English words ───
const current = [
  { word: 'money', weight: 8, inLexicon: true },
  { word: 'plan', weight: 5, inLexicon: false },
];
const picked = pickSupplementWords(
  ['Savings', 'MONEY', 'pocket money', 'x', 'ma’am', 'a very long phrase here', 'സമ്പാദ്യം', 'budget', 42, null],
  current,
  6
);
const words = picked.map((p: any) => p.word);
assert.deepStrictEqual(
  words,
  ['savings', 'pocket money', 'budget'],
  'keeps clean new terms; drops duplicates, non-Latin, junk, and 3+ word phrases'
);
assert.ok(picked.every((p: any) => p.weight === 3), 'named words get a modest fixed weight, never outranking counted ones');
assert.ok(picked.every((p: any) => p.inLexicon === false), 'supplements are not lesson-deck vocabulary');

// ── The cap counts what is already there ──────────────────────────────────
const capped = pickSupplementWords(['alpha', 'beta', 'gamma', 'delta', 'epsilon'], current, 4);
assert.strictEqual(capped.length, 2, 'cap of 4 with 2 existing words admits exactly 2 more');

// ── Garbage in, nothing out ───────────────────────────────────────────────
assert.deepStrictEqual(pickSupplementWords(undefined, current, 10), [], 'no list: no additions');
assert.deepStrictEqual(pickSupplementWords('not-an-array', current, 10), [], 'wrong shape: no additions');

console.log('cloud supplement: 9/9 checks passed');
