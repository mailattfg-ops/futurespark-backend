/**
 * transcription.utils.ts
 *
 * Pure utility functions, constants, and the TpmPacer class extracted from
 * groq-transcription.service.ts.  Nothing here makes HTTP calls or holds
 * instance state; it can be imported by check scripts and tests safely.
 */

import { logger } from '@futurespark/logger';
import { type ProviderConfig } from './transcription.types';

// ─────────────────────────────────────────────────────────────────────────────
// Model / env constants
// ─────────────────────────────────────────────────────────────────────────────

/** Speech-to-text. $0.04/hr of audio, 216x realtime, multilingual. */
export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

/** Groq's own recommended successor to llama-3.3-70b-versatile. */
export const DEFAULT_SUMMARY_MODEL = 'openai/gpt-oss-120b';

/** Line break, named so prompt strings can be assembled without escapes. */
export const NEWLINE = String.fromCharCode(10);

export const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Upload ceiling per request.
 *
 * Groq's free tier rejects anything over 25 MB (dev tier: 100 MB). At the
 * 16 kHz mono 32 kbps this pipeline encodes to, 25 MB is about 104 minutes —
 * so a 90-minute class fits with little to spare. Default 24 to leave headroom.
 */
export const DEFAULT_MAX_UPLOAD_MB = 24;

/** Length of each piece when an audio file has to be split. */
export const DEFAULT_CHUNK_SECONDS = 900; // 15 min ≈ 3.6 MB at 32 kbps

// ─────────────────────────────────────────────────────────────────────────────
// Env helpers
// ─────────────────────────────────────────────────────────────────────────────

export const readEnv = (...names: string[]): string | undefined => {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
};

export const readNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Strip a trailing slash so `${base}/chat/completions` cannot double up. */
export const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, '');

// ─────────────────────────────────────────────────────────────────────────────
// Provider helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OpenRouter wants an app identifier, and lets data handling be enforced at
 * the routing layer. These are class recordings of named children, so routing
 * is restricted to Zero-Data-Retention endpoints.
 */
export const isOpenRouter = (baseUrl: string): boolean => baseUrl.includes('openrouter.ai');

export const providerHeaders = (config: ProviderConfig): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (isOpenRouter(config.baseUrl)) {
    headers['HTTP-Referer'] = readEnv('AI_APP_URL') || 'https://app.finquo.ai';
    headers['X-Title'] = readEnv('AI_APP_NAME') || 'FINQUO Junior';
  }
  return headers;
};

/** Body fields that only OpenRouter understands. */
export const providerBodyExtras = (config: ProviderConfig): Record<string, unknown> => {
  if (!isOpenRouter(config.baseUrl)) return {};
  if (readEnv('AI_REQUIRE_ZDR') === 'false') return {};
  return {
    provider: {
      // Route only to endpoints that retain nothing, and refuse any provider
      // that collects data. A child's lesson must not become training data.
      zdr: true,
      data_collection: 'deny',
    },
  };
};

/** Resolve the ffmpeg binary once, the same way the rest of the pipeline does. */
export const resolveFfmpeg = (): string => {
  try {
    return require('@ffmpeg-installer/ffmpeg').path || require('ffmpeg-static') || 'ffmpeg';
  } catch (e) {
    try {
      return require('ffmpeg-static') || 'ffmpeg';
    } catch (_) {
      return 'ffmpeg';
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TPM pacer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keep a request under a tokens-per-minute ceiling.
 *
 * Groq's free tier meters TPM, so firing the analysis passes back to back would
 * trip the very limit the passes exist to avoid. This tracks what has been sent
 * in the last rolling minute and sleeps until there is room.
 *
 * Deliberately simple and slightly pessimistic: it counts the tokens we ASK for
 * rather than what Groq bills, so it errs towards waiting. A background job that
 * already runs 90 minutes after the class can afford to wait; a 429 costs the
 * whole report.
 */
export class TpmPacer {
  private readonly window: Array<{ at: number; tokens: number }> = [];

  constructor(private readonly limit: number) { }

  async waitFor(tokens: number): Promise<void> {
    for (; ;) {
      const cutoff = Date.now() - 60_000;
      while (this.window.length > 0 && this.window[0].at < cutoff) this.window.shift();

      const used = this.window.reduce((sum, entry) => sum + entry.tokens, 0);
      if (used + tokens <= this.limit || this.window.length === 0) {
        this.window.push({ at: Date.now(), tokens });
        return;
      }

      // Sleep until the oldest entry falls out of the rolling minute.
      const waitMs = Math.max(1_000, this.window[0].at + 60_000 - Date.now() + 250);
      logger.info(
        `[GroqTranscriptionService] Pacing for the tokens-per-minute limit — waiting ${Math.ceil(waitMs / 1000)}s.`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide / vocabulary utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce a full session deck to its vocabulary.
 *
 * The pass stage needs the session's TERMS — so it can recognise "FOBO" in
 * garbled audio and know which concepts were planned — but the full deck would
 * consume the entire per-request budget before a word of transcript fits.
 *
 * Keeps headings, key terms, activity names and short structural lines; drops
 * the speaker-note prose, which is guidance for the teacher rather than
 * vocabulary for the analyst.
 */
export const condenseSlides = (slides: string): string => {
  if (!slides) return '(No session material available.)';

  const kept: string[] = [];
  for (const rawLine of slides.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || /^\d+$/.test(line)) continue; // slide numbers

    const isHeading =
      /^(KEY TERM|ACTIVITY|STOP \d|SECTION|QUESTION \d|LEVEL \d|TAKE HOME|FUN FACT|MIND MAP)/.test(line) &&
      line.length <= 60;
    const isShout = line === line.toUpperCase() && line.length > 2 && line.length < 60;
    const isShort = line.length <= 70;

    if (isHeading || isShout || isShort) kept.push(line);
    if (kept.length >= 220) break;
  }

  const out = [...new Set(kept)].join('\n');
  return out.length > 0 ? out.slice(0, 6_000) : slides.slice(0, 6_000);
};

/** Case-insensitive dedupe that keeps the first spelling seen. */
export const dedupeStrings = (values: unknown[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text.length === 0) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

/**
 * The programme's core vocabulary — terms any class may reach regardless of
 * what its deck says. A session's own terms always come FIRST in the hint;
 * this list fills the remaining budget.
 */
export const CORE_FINANCIAL_VOCABULARY = [
  'money', 'saving', 'savings', 'spending', 'budget', 'budgeting', 'income', 'expense',
  'needs', 'wants', 'emergency fund', 'insurance', 'premium', 'claim', 'protection',
  'bank', 'bank account', 'interest', 'compound interest', 'loan', 'EMI', 'borrowing',
  'credit', 'debit', 'credit card', 'debit card', 'UPI', 'digital payment', 'online fraud',
  'scam', 'investment', 'investing', 'risk', 'return', 'inflation', 'stock', 'mutual fund',
  'tax', 'salary', 'pocket money', 'financial goal', 'profit', 'loss', 'price', 'discount',
  'unit price', 'impulse buying', 'FOBO',
];

/**
 * Distil the class context into a short term list for the TRANSCRIPTION stage.
 * Priming it with the session's own terms biases recognition toward the words
 * actually being said.
 */
export const buildVocabularyHint = (context: { sessionTitle?: string | null; plannedTopics?: string[]; slideContent?: string | null }): string => {
  const terms: string[] = [];
  if (context.sessionTitle) terms.push(context.sessionTitle.trim());
  for (const topic of context.plannedTopics ?? []) terms.push(topic);

  const slides = (context.slideContent ?? '').trim();
  if (slides) {
    for (const line of condenseSlides(slides).split('\n')) {
      const term = line
        .replace(/^(KEY TERM|ACTIVITY|SECTION|STOP \d|QUESTION \d|LEVEL \d|TAKE HOME|FUN FACT|MIND MAP)[\s\d·:.–-]*/i, '')
        .trim();
      if (term.length >= 3 && term.length <= 40 && !/^\d+$/.test(term)) terms.push(term);
    }
  }

  terms.push(...CORE_FINANCIAL_VOCABULARY);
  return dedupeStrings(terms).join(', ').slice(0, 1200);
};

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shift a chunk's [mm:ss] stamps onto the class's clock.
 *
 * A long recording is transcribed in 15-minute pieces and an audio-chat model
 * stamps each piece from 00:00. Concatenated, the timeline stepped backwards
 * at every seam. Only the stamp is rewritten; the words are untouched.
 */
const STAMP_AT_LINE_START = /^(\s*(?:[-*•–—]\s*)?)[[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?[\])]?(?=\s*[A-Za-z])/gm;

export const rebaseStamps = (text: string, offsetSeconds: number): string => {
  if (offsetSeconds === 0) return text;
  return text.replace(STAMP_AT_LINE_START, (_, prefix, mm, ss, msec) => {
    const originalMs = (Number(mm) * 60 + Number(ss)) * 1000 + (msec ? Number(msec) * 10 : 0);
    const shiftedMs = originalMs + offsetSeconds * 1000;
    const totalSec = Math.floor(shiftedMs / 1000);
    const newMm = Math.floor(totalSec / 60);
    const newSs = totalSec % 60;
    return `${prefix}[${newMm}:${String(newSs).padStart(2, '0')}]`;
  });
};
