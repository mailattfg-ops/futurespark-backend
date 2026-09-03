import { parseRepairedJson } from './json-repair';
import axios from 'axios';
const FormData = require('form-data');
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from '@futurespark/logger';
import {
  CLOUD_MAX_TERMS,
  type WordCloudEntry,
  NOT_AVAILABLE,
  parseSessionReport,
  sessionReportToText,
  buildSessionReport,
  assertParentSafe,
  checkParentSafety,
  ParentReportBlocked,
  analysisFingerprint,
  buildSessionLexicon,
  deriveMetrics,
  deriveTalkShare,
  mergeEnvelopes,
  parseAnalysisEnvelope,
  renderTurns,
  sliceByTurns,
  toNumberedTurns,
  transcriptStats,
  PROMPT_SUITE_VERSION,
  type AnalysisEnvelope,
  type SessionReport,
  type SessionReportMeta,
  type Turn,
} from '@futurespark/constants';
import { describeGroqFailure, estimateTokens, GroqError } from './groq-errors';
import { getActivePrompt, getLastModels, recordAiError, recordAiUsage } from '../ai-admin/ai-admin.service';
import {
  ANALYSIS_PROMPT_DEFAULT,
  MODEL_CALL_DEFAULTS,
  TRANSCRIPTION_PROMPT_DEFAULT,
  buildAnalysisSystemPrompt,
  buildPassSystemPrompt,
  buildReduceSystemPrompt,
  renderPrompt,
} from '../ai-admin/prompt-defaults';

/**
 * Everything known about the lesson before a word of it is analysed.
 *
 * `slideContent` is the whole point: without it the model can only describe
 * what it heard, and financial vocabulary spoken by a child over a phone mic is
 * exactly the kind of audio Whisper garbles. With the slides in hand it can
 * recognise "FOBO" rather than transcribing "pho-bo", and can state which of the
 * planned stops the class actually reached.
 */
export interface ClassAnalysisContext {
  sessionTitle?: string | null;
  sessionOrder?: number | null;
  sessionTotal?: number | null;
  /** The presentation text for this session. See Session.slideContent. */
  slideContent?: string | null;
  /** The session's mind-map topics, flattened to titles. */
  plannedTopics?: string[];
  classDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** Real audio length in seconds, when the recording reported one. */
  audioSeconds?: number | null;
  /** For the usage ledger and error log — which class this spend belongs to. */
  classId?: string | null;
  recordingId?: string | null;
}

/**
 * What comes back from one analysed class, beyond the parent report.
 *
 * `internalFlags` and `heldForReview` are new. The pipeline previously had
 * nowhere to put "something about this session needs a human", so it either
 * printed it on the parent's PDF or dropped it entirely.
 */
export interface ClassAnalysisResult {
  transcript: string;
  classSummary: string;
  metrics: any;
  report: SessionReport | null;
  usedFallback: boolean;
  internalFlags: AnalysisEnvelope['internalFlags'];
  heldForReview: boolean;
  holdReason: string | null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * GROQ MODEL IDS
 *
 * Read from the environment, because Groq retires models on a few weeks'
 * notice and a hardcoded id turns that into an outage that needs a deploy to
 * fix. `llama-3.3-70b-versatile` — the model this pipeline used to name
 * directly — was announced for shutdown on 2026-06-17 and stopped being served
 * on 2026-08-16, which would have silently killed every parent report.
 *
 * Check https://console.groq.com/docs/deprecations before pinning a new one.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Speech-to-text. $0.04/hr of audio, 216x realtime, multilingual. */
const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

/** Line break, named so prompt strings can be assembled without escapes. */
const NEWLINE = String.fromCharCode(10);
/** Groq's own recommended successor to llama-3.3-70b-versatile. */
const DEFAULT_SUMMARY_MODEL = 'openai/gpt-oss-120b';

/* ══════════════════════════════════════════════════════════════════════════
 * PROVIDERS
 *
 * Transcription and analysis are configured SEPARATELY, because the best model
 * for each is rarely the same vendor. Both speak the OpenAI wire format, so a
 * provider is a base URL, a key and a model slug — nothing structural.
 *
 * The split matters here specifically: Groq's free tier meters the analysis
 * model at 8,000 tokens/minute, which is what forces the multi-pass workaround
 * and turns a 40-second job into seventeen minutes. Pointing ONLY the analysis
 * at another provider removes that, while speech-to-text carries on unchanged.
 *
 * Defaults keep everything on Groq, so an unconfigured deployment behaves
 * exactly as before.
 * ═══════════════════════════════════════════════════════════════════════ */

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

const readEnv = (...names: string[]): string | undefined => {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return undefined;
};

/** Strip a trailing slash so `${base}/chat/completions` cannot double up. */
const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, '');

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Shown in error messages so an operator knows which vendor refused. */
  label: string;
}

/**
 * OpenRouter wants an app identifier, and — more importantly — lets data
 * handling be enforced at the routing layer rather than trusted to a tier's
 * terms. These are class recordings of named children, so routing is
 * restricted to Zero-Data-Retention endpoints and any provider that stores or
 * trains on inputs is refused outright.
 *
 * Ignored by every other vendor, so it is safe to send unconditionally.
 */
const isOpenRouter = (baseUrl: string): boolean => baseUrl.includes('openrouter.ai');

const providerHeaders = (config: ProviderConfig): Record<string, string> => {
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
const providerBodyExtras = (config: ProviderConfig): Record<string, unknown> => {
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

/**
 * Upload ceiling per request.
 *
 * Groq's free tier rejects anything over 25 MB (dev tier: 100 MB). At the
 * 16 kHz mono 32 kbps this pipeline encodes to, 25 MB is about 104 minutes —
 * so a 90-minute class fits with little to spare, and a class that overruns
 * does not. Default 24 to leave headroom for MP3 framing overhead.
 */
const DEFAULT_MAX_UPLOAD_MB = 24;

/** Length of each piece when an audio file has to be split. */
const DEFAULT_CHUNK_SECONDS = 900; // 15 min ≈ 3.6 MB at 32 kbps

const readNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

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
class TpmPacer {
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

    // Case-SENSITIVE, and length-bounded. Decks shout their headings
    // ("KEY TERM · STOP 1"), while the speaker notes underneath are sentences
    // that often open with the same words — "Key term 1. Buying on the spot
    // without planning. Use the notebook-and-chocolate example..." matched as a
    // heading under a case-insensitive rule and dragged a paragraph of teacher
    // guidance into the vocabulary list.
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
const dedupeStrings = (values: unknown[]): string[] => {
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
 * this list fills the remaining budget so that a word the deck never wrote
 * down ("EMI" coming up in a savings class) is still primed, and a class with
 * thin or missing material is never transcribed completely unprimed.
 */
const CORE_FINANCIAL_VOCABULARY = [
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
 *
 * The transcriber only hears audio — it does not know an insurance class is
 * happening, so Malayalam-accented "insurance" comes out as "endurance" and
 * every later stage inherits the mishearing. Priming it with the session's own
 * terms biases recognition toward the words actually being said.
 *
 * Kept short on purpose: Whisper reads ~224 tokens of `prompt`, and a chat
 * model needs the terms, not the deck. Session terms lead so a tight budget
 * cuts the generic tail, never the words specific to this class.
 */
export const buildVocabularyHint = (context: ClassAnalysisContext): string => {
  const terms: string[] = [];
  if (context.sessionTitle) terms.push(context.sessionTitle.trim());
  for (const topic of context.plannedTopics ?? []) terms.push(topic);

  // The condensed deck's short lines are its headings and key terms; strip the
  // structural prefixes so only the term itself primes the transcriber.
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

/** Resolve the ffmpeg binary once, the same way the rest of the pipeline does. */
const resolveFfmpeg = (): string => {
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

let compressionCounter = 0;
// Distinguishes concurrent splits inside one process; the pid covers processes.
let splitRunCounter = 0;

/** The two ways audio can reach a provider. */
type WirePath = 'stt' | 'chat';

/** One rung of the transcription fallback ladder. */
interface TranscriptionAttempt {
  model: string;
  wire: WirePath;
  /** Shown in the log so an operator can see why this rung was tried. */
  why: string;
}

/**
 * The provider answered normally and returned no words.
 *
 * Distinct from a transport or quota failure because the response was a
 * success: it means "this model, on this wire, produced nothing" — which is
 * exactly the case another model or wire may well handle.
 */
class EmptyTranscriptError extends Error {
  constructor(public readonly model: string, public readonly wire: WirePath) {
    super(`"${model}" returned an empty transcript from the audio.`);
    this.name = 'EmptyTranscriptError';
  }
}

/**
 * Failure kinds where trying a different model or wire is worth the money.
 *
 * Deliberately excludes AUTH_FAILED, NO_API_KEY, RATE_LIMITED,
 * SERVICE_UNAVAILABLE, NETWORK_ERROR and TIMEOUT: none of those are about the
 * model's ability to do the job, so walking the ladder would fail identically
 * three times over and spend three times the quota to learn nothing. The
 * retry daemon already handles those with a backoff sized to the cause.
 */
const LADDER_WALKABLE_KINDS = new Set([
  'BAD_RESPONSE',
  'MODEL_RETIRED',
  'REQUEST_TOO_LARGE',
  'AUDIO_TOO_LARGE',
  'UNKNOWN',
]);

/**
 * Shift a chunk's [mm:ss] stamps onto the class's clock.
 *
 * A long recording is transcribed in 15-minute pieces and an audio-chat model
 * stamps each piece from 00:00. Concatenated, the timeline stepped backwards
 * at every seam, `deriveTalkShare` correctly refused to read it as a clock,
 * and every long class fell back to share-of-words — so the one model that
 * CAN measure talk time never got to. Only the stamp is rewritten; the words
 * are untouched. Matches the same shapes the turn parser accepts.
 */
const STAMP_AT_LINE_START = /^(\s*(?:[-*•–—]\s*)?)[[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?[\])]?(?=\s*[A-Za-z])/gm;

export const rebaseStamps = (text: string, offsetSeconds: number): string => {
  if (!offsetSeconds) return text;
  return text.replace(STAMP_AT_LINE_START, (_m, lead: string, a: string, b: string, c?: string) => {
    const within = c !== undefined ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
    const total = within + offsetSeconds;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const two = (n: number) => String(n).padStart(2, '0');
    // Two groups read as mm:ss, three as h:mm:ss — so past the hour the hour
    // must be spelled out or "75:12" would parse as 75 minutes.
    return `${lead}[${h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`}]`;
  });
};

export class GroqTranscriptionService {
  // Key presence is judged per RESOLVED provider, not against GROQ_API_KEY.
  // The old check tested GROQ_API_KEY specifically, so a deployment that moved
  // both stages to OpenRouter and removed the Groq key would have every job
  // silently downgraded to the canned placeholder — with a working paid key
  // sitting right there in AI_TRANSCRIPTION_API_KEY / AI_ANALYSIS_API_KEY.
  // Read lazily, not as captured fields: this class is instantiated at module
  // scope by transcription.controller, which can run before dotenv populates
  // process.env.
  private get hasTranscriptionKey(): boolean {
    return this.transcriptionProvider.apiKey.length >= 5;
  }

  private get hasAnalysisKey(): boolean {
    return this.analysisProvider.apiKey.length >= 5;
  }

  /**
   * Models chosen in the admin picker (AppSetting `last_models`). They take
   * precedence over the .env defaults, so changing a model is a dropdown click
   * rather than a redeploy. Refreshed at the start of each pipeline run; the
   * getters stay synchronous by reading this snapshot.
   */
  private storedModels: { transcription?: string; analysis?: string } = {};
  /**
   * Chunks that could not be transcribed on the winning rung.
   *
   * Coverage is then marked from what happened rather than from the analysis
   * model noticing gap markers in the text — a judgement, not a guarantee.
   */
  private transcriptionGaps = 0;

  /**
   * Which class/recording the CURRENT run belongs to, for the usage ledger.
   * Instance state is acceptable here: the retry daemon is serial and manual
   * runs are rare, and a mis-tagged ledger row is advisory metadata, not truth
   * the pipeline depends on.
   */
  private jobTag: { classId?: string | null; recordingId?: string | null; fileName?: string | null } = {};

  /** Values for {{variables}} in the editable prompts, set per run. */
  private promptVars: Record<string, string> = {};
  /** Session terms priming the transcriber — set per job in processClassAudio. */
  private transcriptionVocabulary = '';

  private async refreshStoredModels(): Promise<void> {
    try {
      this.storedModels = await getLastModels();
    } catch {
      // Settings must never block the pipeline; the .env defaults still apply.
      this.storedModels = {};
    }
  }

  /**
   * Where speech-to-text goes.
   *
   * Falls back to the Groq settings so an existing deployment is unaffected by
   * the introduction of the generic names.
   */
  private get transcriptionProvider(): ProviderConfig {
    const baseUrl = normalizeBaseUrl(
      readEnv('AI_TRANSCRIPTION_BASE_URL', 'AI_BASE_URL') ?? DEFAULT_BASE_URL
    );
    return {
      baseUrl,
      apiKey: readEnv('AI_TRANSCRIPTION_API_KEY', 'AI_API_KEY', 'GROQ_API_KEY') ?? '',
      model:
        this.storedModels.transcription ||
        (readEnv('AI_TRANSCRIPTION_MODEL', 'GROQ_TRANSCRIPTION_MODEL') ?? DEFAULT_TRANSCRIPTION_MODEL),
      label: isOpenRouter(baseUrl) ? 'OpenRouter' : baseUrl.includes('groq.com') ? 'Groq' : baseUrl,
    };
  }

  /**
   * Where the session analysis goes.
   *
   * Configured independently of transcription on purpose — the analysis is the
   * half that Groq's free tier makes unusable, and moving only this one fixes
   * it without touching a speech-to-text setup that already works.
   */
  private get analysisProvider(): ProviderConfig {
    const baseUrl = normalizeBaseUrl(readEnv('AI_ANALYSIS_BASE_URL', 'AI_BASE_URL') ?? DEFAULT_BASE_URL);
    return {
      baseUrl,
      apiKey: readEnv('AI_ANALYSIS_API_KEY', 'AI_API_KEY', 'GROQ_API_KEY') ?? '',
      model:
        this.storedModels.analysis ||
        (readEnv('AI_ANALYSIS_MODEL', 'GROQ_SUMMARY_MODEL') ?? DEFAULT_SUMMARY_MODEL),
      label: isOpenRouter(baseUrl) ? 'OpenRouter' : baseUrl.includes('groq.com') ? 'Groq' : baseUrl,
    };
  }

  private get transcriptionModel(): string {
    return this.transcriptionProvider.model;
  }

  private get summaryModel(): string {
    return this.analysisProvider.model;
  }

  private get maxUploadBytes(): number {
    return readNumberEnv('GROQ_MAX_UPLOAD_MB', DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
  }

  private get chunkSeconds(): number {
    return readNumberEnv('GROQ_CHUNK_SECONDS', DEFAULT_CHUNK_SECONDS);
  }

  /**
   * Main Pipeline: Transcribe audio/video and generate master parent summary & interaction metrics
   */
  async processClassAudio(
    audioFilePath: string,
    studentName: string = 'Student',
    mentorName: string = 'Instructor',
    context: ClassAnalysisContext = {}
  ) {
    logger.info(`[GroqTranscriptionService] [+] Processing file: ${audioFilePath} for ${studentName} & ${mentorName}`);

    // Per-job state. The gap counter is instance state on a long-lived
    // service, so a previous class's gaps must not leak into this one.
    this.transcriptionGaps = 0;

    // Admin-picked models override the .env defaults from here on.
    await this.refreshStoredModels();
    this.jobTag = {
      classId: context.classId ?? null,
      recordingId: context.recordingId ?? null,
      fileName: path.basename(audioFilePath.split('?')[0] ?? '') || null,
    };
    this.promptVars = {
      student_name: studentName,
      teacher_name: mentorName,
      session_topic: context.sessionTitle ?? '',
      session_number: context.sessionOrder != null ? String(context.sessionOrder) : '',
    };
    this.transcriptionVocabulary = buildVocabularyHint(context);
    const hasSessionTerms = Boolean(
      context.sessionTitle || (context.plannedTopics ?? []).length > 0 || (context.slideContent ?? '').trim()
    );
    if (hasSessionTerms) {
      logger.info(
        `[GroqTranscriptionService] Priming transcription with ${this.transcriptionVocabulary.split(', ').length} term(s)` +
        (context.sessionTitle ? ` for "${context.sessionTitle}"` : '') +
        ' (session material + core vocabulary).'
      );
    } else {
      logger.warn(
        '[GroqTranscriptionService] No session material for this class — transcription primed with the core financial vocabulary only.'
      );
    }

    let localFilePath = audioFilePath;
    const isUrl = audioFilePath.startsWith('http://') || audioFilePath.startsWith('https://');

    // Both the STT and summary stages degrade to canned placeholder text when
    // their provider has no key. Surface that to callers so placeholder output
    // is never cached or persisted as if it were a real AI summary.
    const usedFallback = !this.hasTranscriptionKey || !this.hasAnalysisKey;
    if (usedFallback) {
      const missing = [
        !this.hasTranscriptionKey && `transcription (${this.transcriptionProvider.label}: set AI_TRANSCRIPTION_API_KEY or AI_API_KEY)`,
        !this.hasAnalysisKey && `analysis (${this.analysisProvider.label}: set AI_ANALYSIS_API_KEY or AI_API_KEY)`,
      ].filter(Boolean).join(' and ');
      logger.error(
        `[GroqTranscriptionService] No API key for ${missing} — returning PLACEHOLDER transcript/summary, not real AI output.`
      );
    }

    try {
      if (isUrl) {
        const tempDir = os.tmpdir();
        const cleanUrl = audioFilePath.split('?')[0];
        const ext = path.extname(cleanUrl) || '.mp3';
        const tempFileName = `transcribe-${Date.now()}${ext}`;
        localFilePath = path.join(tempDir, tempFileName);
        logger.info(`[GroqTranscriptionService] Downloading S3 audio file from: ${audioFilePath} to local temp path: ${localFilePath}`);

        const response = await axios({
          method: 'GET',
          url: audioFilePath,
          responseType: 'stream',
        });

        const writer = fs.createWriteStream(localFilePath);
        response.data.pipe(writer);

        await new Promise<void>((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        logger.info(`[GroqTranscriptionService] Download completed.`);
      }

      // Extract & compress audio if file size > 20MB or is a video file (Groq limit: 25MB)
      const fileToTranscribe = this.compressAudioIfNeeded(localFilePath);

      // 1. Transcribe. Errors already carry their diagnosis, so they are
      //    re-thrown untouched rather than wrapped in a vaguer message.
      let transcript = await this.transcribeWithGroqWhisper(fileToTranscribe);

      // Every stored transcript names its speakers, whichever model produced
      // it. Whisper returns unlabelled prose; this labels it in one text pass.
      // A no-op when the transcription model already labelled the turns.
      transcript = await this.ensureSpeakerLabels(transcript, studentName, mentorName);

      /* ── 2. Turns, not prose ─────────────────────────────────────────────
       * Everything downstream now works on numbered turns. This is the change
       * that makes the metrics reproducible: evidence can cite a turn, a
       * citation can be verified, and evidence gathered from two overlapping
       * analysis passes merges exactly instead of being summed.
       * ─────────────────────────────────────────────────────────────────── */
      const turns = toNumberedTurns(transcript, studentName, mentorName);
      const stats = transcriptStats(turns);
      const talk = deriveTalkShare(turns, context.audioSeconds ?? null);

      if (turns.length === 0) {
        throw new GroqError(
          describeGroqFailure(
            new Error('The transcript produced no speaking turns, so nothing can be analysed.'),
            'analysis',
            { model: this.summaryModel, provider: this.analysisProvider.label }
          )
        );
      }
      if (talk.basis === 'unmeasurable') {
        logger.warn(
          '[GroqTranscriptionService] Talk time is not measurable from this transcript ' +
          `(${stats.teacherTurns} teacher turn(s), ${stats.studentTurns} student turn(s), ` +
          `${stats.unlabelledTurns} unlabelled). The report will say "Not available" rather than ` +
          'invent a split.'
        );
      } else if (talk.basis === 'word-share') {
        logger.info(
          '[GroqTranscriptionService] No usable [mm:ss] stamps — reporting SHARE OF WORDS, not talk ' +
          'time. Use an audio-capable chat model for timestamped turns and this becomes a real measurement.'
        );
      }

      const metrics = {
        ...stats,
        questionCount: stats.studentTurns > 0 ? (transcript.match(/\?/g) || []).length : 0,
        mentorShareRatio: talk.teacherPercent,
        studentShareRatio: talk.studentPercent,
        talkTimeBasis: talk.basis,
        engagementRating:
          talk.studentPercent === null
            ? 'UNKNOWN'
            : talk.studentPercent >= 25
              ? 'HIGH'
              : talk.studentPercent >= 15
                ? 'MEDIUM'
                : 'MODERATE',
      };

      // 3. Analyse against the session material. Returns evidence + narrative;
      //    every number is computed here, not by the model.
      const analysed = await this.generateSessionReport(turns, studentName, mentorName, context);
      const report = this.finalizeReport(analysed.report, context, talk);

      /* ── 4. The gate ─────────────────────────────────────────────────────
       * Instructions lower the rate of a bad sentence; they do not make it
       * zero, and the costs are not symmetrical. A held report is a WhatsApp
       * message delayed by an hour. A released one naming the mentor's mistake,
       * or repeating what the child said about the family's loan, is permanent
       * and forwardable.
       *
       * Deliberately does NOT regenerate or redact: the model wrote that
       * sentence because something in the recording prompted it, and quietly
       * rewriting it destroys the only signal that the session needs a look.
       * ─────────────────────────────────────────────────────────────────── */
      let heldForReview = false;
      let holdReason: string | null = null;
      try {
        const safety = assertParentSafe(report, context.recordingId ?? null);
        if (safety.warnings.length > 0 && report.meta) {
          report.meta.safetyWarnings = safety.warnings.map((w) => `${w.rule}: ${w.field}`);
        }
      } catch (err: any) {
        if (!(err instanceof ParentReportBlocked)) throw err;
        heldForReview = true;
        holdReason = err.message;
        logger.error(`[GroqTranscriptionService] ${err.message}`);
      }

      // A flagged session is held even when the wording came out clean — the
      // flag is about what HAPPENED, not about what got written down.
      const escalating = analysed.envelope.internalFlags.filter(
        (f) => f.kind === 'safeguarding' || f.kind === 'child_disclosure' || f.kind === 'session_disruption'
      );
      if (escalating.length > 0 && !heldForReview) {
        heldForReview = true;
        holdReason = `Held for review — ${escalating.map((f) => f.kind).join(', ')} flagged during analysis.`;
        logger.warn(`[GroqTranscriptionService] ${holdReason}`);
      }

      if (heldForReview) {
        void import('../shared/audit').then(({ recordAudit }) =>
          recordAudit({
            actorRole: 'SYSTEM',
            action: 'flagged',
            entityType: 'ai-summary',
            entityId: this.jobTag.recordingId ?? null,
            entityName: this.jobTag.fileName ?? null,
            summary: (holdReason ?? 'Parent report held for review.').slice(0, 240),
          })
        ).catch(() => { });
      }

      const classSummary = sessionReportToText(report);

      // Clean up temporary compressed audio if created
      if (fileToTranscribe !== audioFilePath && fs.existsSync(fileToTranscribe)) {
        try { fs.unlinkSync(fileToTranscribe); } catch (_) { }
      }

      const result: ClassAnalysisResult = {
        transcript,
        classSummary,
        metrics,
        report,
        usedFallback,
        internalFlags: analysed.envelope.internalFlags,
        heldForReview,
        holdReason,
      };
      return result;
    } catch (err: any) {
      logger.error(`[GroqTranscriptionService] Fatal error in audio processing: ${err.message}`);

      // One choke point writes the structured error log for the /errors page
      // AND drops a system line into the Activity Log feed.
      const failure = err instanceof GroqError ? err.failure : null;

      void import('../shared/audit').then(({ recordAudit }) =>
        recordAudit({
          actorRole: 'SYSTEM',
          action: 'failed',
          entityType: 'ai-summary',
          entityId: this.jobTag.recordingId ?? null,
          entityName: this.jobTag.fileName ?? null,
          summary: `The AI pipeline failed on ${this.jobTag.fileName ?? 'a recording'}: ${(failure?.summary ?? String(err?.message ?? err)).slice(0, 140)
            }`,
        })
      ).catch(() => { });
      void recordAiError({
        stage: failure?.stage ?? 'transcription',
        kind: failure?.kind ?? 'UNKNOWN',
        provider: failure?.provider ?? null,
        model: failure?.model ?? null,
        message: failure?.summary ?? String(err?.message ?? err).slice(0, 500),
        detail: failure?.detail ?? err?.stack ?? null,
        remedy: failure?.remedy ?? null,
        retryable: failure?.retryable ?? false,
        classId: this.jobTag.classId,
        recordingId: this.jobTag.recordingId,
      });

      throw err;
    }
  }

  /**
   * Compress audio/video file locally using ffmpeg if size > 20MB or is video format
   */
  /** The file's real length in seconds, read from its container header. */
  private probeSeconds(ffmpegPath: string, file: string): number | null {
    try {
      if (!fs.existsSync(file)) return null;
      const { spawnSync } = require('child_process');
      // "-i" with no real output exits non-zero by design; the header is on stderr.
      const res = spawnSync(ffmpegPath, ['-i', file, '-f', 'null', '-t', '0', '-'], { encoding: 'utf8' });
      const m = /Duration: ([0-9]+):([0-9]{2}):([0-9]{2})[.]([0-9]{1,2})/.exec(String(res.stderr || ''));
      if (!m) return null;
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
    } catch {
      return null;
    }
  }

  private compressAudioIfNeeded(filePath: string): string {
    const stats = fs.statSync(filePath);
    const fileSizeMb = stats.size / (1024 * 1024);
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

    if (fileSizeMb < 20.0 && ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'].includes(ext)) {
      return filePath;
    }

    /* The compressed copy is what the AI actually hears, so it gets the same
     * treatment as the extraction upstream: a unique temp name, a length check
     * against the source, and only then a rename into the cache slot.
     *
     * This used to write to one fixed path and reuse whatever sat there if it
     * was over 1 MB. Two transcriptions of the same recording — the auto-trigger
     * and a retry, say — therefore wrote the same file at the same time; and
     * once a bad file landed there, every later attempt reused it and returned
     * the same nonsense. A stretched track still transcribes, confidently, so
     * it has to be measured rather than assumed. */
    const cachePath = filePath + '.compressed.mp3';

    let ffmpegPath = 'ffmpeg';
    try {
      ffmpegPath = require('@ffmpeg-installer/ffmpeg').path || require('ffmpeg-static') || 'ffmpeg';
    } catch (e) {
      try {
        ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
      } catch (_) { }
    }

    const sourceSeconds = this.probeSeconds(ffmpegPath, filePath);
    const matchesSource = (candidate: number | null): boolean =>
      sourceSeconds !== null &&
      candidate !== null &&
      Math.abs(candidate - sourceSeconds) <= Math.max(5, sourceSeconds * 0.02);

    // Reuse a cached track only when it still measures correct.
    if (fs.existsSync(cachePath)) {
      if (matchesSource(this.probeSeconds(ffmpegPath, cachePath))) {
        logger.info(`[GroqTranscriptionService] Reusing verified compressed audio: ${cachePath}`);
        return cachePath;
      }
      logger.warn(
        `[GroqTranscriptionService] Discarding a cached compressed track that no longer matches its source: ${cachePath}`
      );
      try { fs.unlinkSync(cachePath); } catch (_) { }
    }

    logger.info(`[GroqTranscriptionService] [+] File size: ${fileSizeMb.toFixed(2)}MB (${ext}). Extracting & compressing audio to MP3...`);

    const { execFileSync } = require('child_process');
    const tempOutput = `${filePath}.${process.pid}.${compressionCounter++}.tmp.mp3`;
    try {
      execFileSync(
        ffmpegPath,
        ['-y', '-i', filePath, '-vn', '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-write_xing', '1', tempOutput],
        { stdio: 'pipe' }
      );

      const producedSeconds = this.probeSeconds(ffmpegPath, tempOutput);
      if (producedSeconds === null) {
        throw new Error('the compressed track has no readable duration, which means a malformed file');
      }
      if (sourceSeconds !== null && !matchesSource(producedSeconds)) {
        throw new Error(
          `the compressed track is ${producedSeconds === null ? 'unreadable' : Math.round(producedSeconds) + 's'} ` +
          `but the source is ${Math.round(sourceSeconds)}s — refusing to send it to the model`
        );
      }

      const newSizeMb = fs.statSync(tempOutput).size / (1024 * 1024);
      // Only a measured file is ever promoted into the cache slot.
      fs.renameSync(tempOutput, cachePath);
      logger.info(
        sourceSeconds !== null
          ? `[GroqTranscriptionService] Compressed audio verified against its source: ${cachePath} ` +
          `(${newSizeMb.toFixed(2)}MB, ${Math.round(producedSeconds)}s) - Ready for transcription`
          : `[GroqTranscriptionService] Compressed audio produced: ${cachePath} (${newSizeMb.toFixed(2)}MB, ` +
          `${Math.round(producedSeconds)}s). The source length could not be read, so the two were NOT compared.`
      );
      return cachePath;
    } catch (err: any) {
      try { fs.unlinkSync(tempOutput); } catch (_) { }
      logger.warn(`[GroqTranscriptionService] Compression failed: ${err.message}. Falling back to the original file.`);
      return filePath;
    }
  }

  /**
   * 1. Speech-to-text (whatever provider AI_TRANSCRIPTION_BASE_URL points at)
   */
  private async transcribeWithGroqWhisper(filePath: string): Promise<string> {
    if (!this.hasTranscriptionKey) {
      /* ── Fabrication is worse than failure ───────────────────────────────
       * This used to return canned text about "key concepts and hands-on
       * exercises" that flowed through the entire pipeline and could be
       * rendered into a parent's PDF describing a class that never happened.
       * `usedFallback` was the only thing between that and WhatsApp, and it is
       * advisory. It now throws unless an operator explicitly opts in locally.
       * ─────────────────────────────────────────────────────────────────── */
      if (readEnv('AI_ALLOW_PLACEHOLDER') !== 'true') {
        throw new GroqError(
          describeGroqFailure(
            new Error(
              'No transcription API key is set. Refusing to generate a placeholder transcript: it ' +
              'would produce a parent report about a class that was never analysed. Set ' +
              'AI_TRANSCRIPTION_API_KEY, or AI_ALLOW_PLACEHOLDER=true for local development.'
            ),
            'transcription',
            { model: this.transcriptionModel, provider: this.transcriptionProvider.label }
          )
        );
      }
      logger.warn('[GroqTranscriptionService] AI_ALLOW_PLACEHOLDER=true — returning a placeholder transcript. This must never run in production.');
      return `[00:00:05] Instructor: Welcome to today's live interactive session. Today we are exploring key concepts and hands-on exercises for this program.
[00:00:22] Student: Thank you! I'm ready to get started. I had a quick question regarding the initial concepts we discussed in the pre-session reading.
[00:00:45] Instructor: Great question! Let's break that down step-by-step. First, we need to examine how the fundamental principles operate in practice.
[00:01:30] Student: Ah, I see now. So when we apply that logic, does it change the outcome for edge cases?
[00:02:15] Instructor: Exactly right. That is why we structure our solution carefully. Let's work through a live demonstration together.
[00:03:40] Student: That makes complete sense. I appreciate the clear explanation and live walkthrough.
[00:04:50] Instructor: Excellent progress today! For your assignment before our next session, review the key formulas and practice the remaining exercises. See you next class!`;
    }

    return this.transcribeWithLadder(filePath);
  }

  /**
   * Build the list of (model, wire) combinations to try, in order.
   *
   * The admin model picker accepts any model id, and nothing there knows
   * whether the model can hear audio or which endpoint it wants. Rather than
   * validate a list that would go stale with every provider release, the
   * pipeline simply tries the sensible alternatives:
   *
   *   1. the chosen model on the wire its name suggests
   *   2. the SAME model on the other wire — the name is only a guess, and a
   *      model without "whisper" in it may still be a real STT endpoint
   *   3. the fallback model, which is known to transcribe
   *
   * Rung 3 is what guarantees a class is never lost to a model choice.
   */
  private buildAttemptLadder(): TranscriptionAttempt[] {
    const chosen = this.transcriptionModel;
    const primaryWire = this.wirePathFor(chosen);
    const otherWire: WirePath = primaryWire === 'stt' ? 'chat' : 'stt';

    const fallbackModel =
      readEnv('AI_TRANSCRIPTION_FALLBACK_MODEL') ?? DEFAULT_TRANSCRIPTION_MODEL;

    const ladder: TranscriptionAttempt[] = [
      { model: chosen, wire: primaryWire, why: 'the selected model' },
    ];

    /* The other-wire rung is a hedge against the NAME being a bad guess, so it
     * is only worth trying when the name told us little. A whisper-family
     * model genuinely only exists at /audio/transcriptions, so posting it to
     * /chat/completions base64-encodes the whole class, waits out the full
     * timeout and fails — guaranteed, every time. */
    if (!this.isDedicatedSttModel(chosen)) {
      ladder.push({ model: chosen, wire: otherWire, why: 'the selected model on the other endpoint' });
    }

    // Only worth a rung if it is genuinely a different model.
    if (fallbackModel && fallbackModel !== chosen) {
      ladder.push({
        model: fallbackModel,
        wire: this.wirePathFor(fallbackModel),
        why: 'the fallback transcription model',
      });
    }

    // Same (model, wire) twice buys nothing — dedupe while keeping order.
    const seen = new Set<string>();
    return ladder.filter((a) => {
      const key = `${a.model}::${a.wire}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Try each rung until one produces words.
   *
   * A rung is abandoned only for reasons that another rung could plausibly fix
   * (see LADDER_WALKABLE_KINDS, plus an empty transcript). A bad key or a
   * quota rejection is re-thrown immediately — it would fail identically on
   * every rung, and the retry daemon backs those off properly.
   */
  private async transcribeWithLadder(filePath: string): Promise<string> {
    const ladder = this.buildAttemptLadder();
    let lastError: any = null;

    for (let i = 0; i < ladder.length; i++) {
      const attempt = ladder[i];
      const wireLabel = attempt.wire === 'stt' ? '/audio/transcriptions' : '/chat/completions';
      logger.info(
        `[GroqTranscriptionService] Transcription attempt ${i + 1}/${ladder.length} — ` +
        `"${attempt.model}" via ${wireLabel} (${attempt.why}).`
      );

      try {
        const transcript = await this.transcribeOnce(filePath, attempt);
        if (i > 0) {
          logger.warn(
            `[GroqTranscriptionService] Transcribed with "${attempt.model}" via ${wireLabel} after ` +
            `${i} earlier attempt(s) produced nothing. The selected model may not suit this audio — ` +
            'check the model setting if this repeats.'
          );
        }
        return transcript;
      } catch (err: any) {
        lastError = err;

        const isEmpty = err instanceof EmptyTranscriptError;
        const kind = err instanceof GroqError ? err.failure.kind : undefined;
        const walkable = isEmpty || (kind !== undefined && LADDER_WALKABLE_KINDS.has(kind));
        const isLastRung = i === ladder.length - 1;

        if (!walkable) {
          // Not about this model's ability — stop and report the real cause.
          throw err;
        }
        if (isLastRung) break;

        logger.warn(
          `[GroqTranscriptionService] "${attempt.model}" via ${wireLabel} produced no transcript ` +
          `(${isEmpty ? 'empty response' : kind}). Falling back to the next option.`
        );
      }
    }

    /* Every rung walked and none produced words.
     *
     * The last rung's own error must NOT be re-thrown as the cause: it names
     * whichever model the ladder ended on — often the fallback the operator
     * never chose — and its remedy points at AI_TRANSCRIPTION_MODEL, which is
     * not the setting that produced it. Compose the attempt list instead. */
    throw new GroqError(
      describeGroqFailure(
        new Error(
          `No transcription model produced a transcript for this audio. Tried: ` +
          `${ladder.map((a) => `"${a.model}" (${a.wire})`).join(', ')}. ` +
          `Last error: ${lastError?.message ?? 'unknown'}. ` +
          'If the audio is silent this is correct; otherwise change the transcription model.'
        ),
        'transcription',
        { model: this.transcriptionModel, provider: this.transcriptionProvider.label }
      )
    );
  }

  /** One model on one wire: whole file if it fits, chunked if it does not. */
  private async transcribeOnce(filePath: string, attempt: TranscriptionAttempt): Promise<string> {
    const sizeBytes = fs.statSync(filePath).size;
    const ceiling = this.maxBytesFor(attempt.wire);

    // Small enough to send whole — the common case for a 60-90 minute class.
    if (sizeBytes <= ceiling) {
      return this.uploadForTranscription(filePath, undefined, attempt);
    }

    /* ── Too big for one request ──────────────────────────────────────────
     * Groq's free tier hard-rejects anything over 25 MB. Before this, a class
     * that ran long simply failed with an opaque API error, no transcript, no
     * summary and therefore no parent report — and nothing said why.
     *
     * Splitting is preferable to encoding at a lower bitrate: dropping below
     * 32 kbps starts costing word accuracy, and the ceiling would only move,
     * not disappear. Chunks are cut with `-c copy`, so there is no re-encode
     * and no second generation of quality loss.
     * ─────────────────────────────────────────────────────────────────── */
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
    logger.info(
      `[GroqTranscriptionService] Audio is ${sizeMb}MB, over the ${(ceiling / (1024 * 1024)).toFixed(0)}MB ` +
      `per-request limit. Splitting into ${this.chunkSeconds / 60}-minute chunks and transcribing in sequence.`
    );

    const chunks = this.splitAudio(filePath);
    if (chunks.length === 0) {
      /* Wrapped, not bare: a plain Error is non-walkable, so an ffmpeg that
       * cannot split aborted the whole ladder on rung 1 — including the
       * whisper rung whose larger multipart ceiling would have sent the file
       * whole and transcribed the class. */
      throw new GroqError(describeGroqFailure(
        new Error(
          `Audio is ${sizeMb}MB, above the ${(ceiling / (1024 * 1024)).toFixed(0)}MB request limit for this endpoint, ` +
          'and it could not be split (ffmpeg failed). Raise GROQ_MAX_UPLOAD_MB if you are on the paid ' +
          'dev tier (100MB), or check that ffmpeg is available.'
        ),
        'transcription',
        { model: attempt.model, provider: this.transcriptionProvider.label }
      ));
    }

    /* ── One chunk failing must not cost the whole class ─────────────────
     * The loop used to await each chunk with no recovery, so a single 429 or a
     * dropped connection on chunk 4 of 6 threw away the five that had already
     * succeeded — and the expensive part (the audio) had already been paid for.
     *
     * Each chunk now gets its own retries with a short backoff, and a chunk
     * that still will not transcribe leaves a visible gap marker rather than
     * silently shortening the lesson. A gap the analyser can see is far better
     * than a transcript that looks complete but is missing fifteen minutes.
     * ────────────────────────────────────────────────────────────────── */
    const parts: string[] = [];
    const perChunkAttempts = readNumberEnv('GROQ_CHUNK_MAX_ATTEMPTS', 3);
    let failedChunks = 0;
    /* A failure this rung cannot fix by trying again — a dead key, a quota
     * rejection. Kept aside and re-thrown VERBATIM once the loop unwinds.
     *
     * Without this the chunked path swallowed every cause and synthesised
     * "Every audio chunk failed to transcribe", which describeGroqFailure can
     * only classify as UNKNOWN — a walkable kind. So on any file large enough
     * to split, a revoked key walked the whole ladder, three retries per chunk
     * per rung, and reached the operator as "check the log" instead of
     * "generate a new key". It also lost the wording the retry daemon reads to
     * size its backoff, turning a 6-hour daily-quota wait into 15 minutes. */
    let fatalError: GroqError | null = null;

    try {
      for (let i = 0; i < chunks.length && fatalError === null; i++) {
        // The tail of the previous chunk is passed as `prompt` so Whisper keeps
        // spelling and terminology consistent across a cut — otherwise a name
        // established in chunk 1 can come back spelled differently in chunk 2.
        const carryOver = parts.length > 0 ? parts[parts.length - 1].slice(-200) : undefined;
        let transcribed: string | null = null;

        // Named tryNo, not attempt: `attempt` is the ladder rung this whole
        // pass belongs to, and shadowing it here silently passed the retry
        // counter to uploadForTranscription in place of the model to use.
        for (let tryNo = 1; tryNo <= perChunkAttempts; tryNo++) {
          try {
            logger.info(
              `[GroqTranscriptionService] Transcribing chunk ${i + 1}/${chunks.length}` +
              `${tryNo > 1 ? ` (attempt ${tryNo}/${perChunkAttempts})` : ''}...`
            );
            transcribed = await this.uploadForTranscription(chunks[i], carryOver, attempt);
            break;
          } catch (err: any) {
            /* Retrying a bad key or an exhausted quota just spends the same
             * money to be told the same thing. Stop the whole rung at once. */
            if (err instanceof GroqError && !LADDER_WALKABLE_KINDS.has(err.failure.kind)) {
              logger.error(
                `[GroqTranscriptionService] Chunk ${i + 1} failed with ${err.failure.kind}, which retrying ` +
                'cannot fix — abandoning this recording without trying the remaining chunks or models.'
              );
              fatalError = err;
              break;
            }
            const last = tryNo === perChunkAttempts;
            logger.warn(
              `[GroqTranscriptionService] Chunk ${i + 1} attempt ${tryNo} failed: ${err.message}` +
              `${last ? ' — giving up on this chunk.' : ' — retrying.'}`
            );
            if (last) break;
            // Linear backoff. A quota rejection needs time, not immediacy.
            await new Promise((resolve) => setTimeout(resolve, tryNo * 20_000));
          }
        }

        if (transcribed === null) {
          failedChunks++;
          parts.push(`[... ${Math.round(this.chunkSeconds / 60)} minutes of this class could not be transcribed ...]`);
        } else {
          // Chunk i began i × chunkSeconds into the class.
          parts.push(rebaseStamps(transcribed, i * this.chunkSeconds));
        }
      }
    } finally {
      for (const chunk of chunks) {
        try { fs.unlinkSync(chunk); } catch (_) { /* best effort */ }
      }
    }

    // The real cause, with its own wording, kind and remedy intact.
    if (fatalError) throw fatalError;

    /* How much of a class may be missing and still be worth reporting on.
     *
     * Returning a string used to count as success at any gap short of total,
     * so five of six chunks could fail and the ladder would stop — never
     * trying the model that would have transcribed all six — while the report
     * was built from the first fifteen minutes and still stamped complete.
     * Above this fraction the rung counts as failed so the ladder moves on;
     * below it the gaps are tolerated and marked. */
    const gapFraction = failedChunks / chunks.length;
    const tolerance = readNumberEnv('TRANSCRIPTION_GAP_TOLERANCE', 0.25);

    if (failedChunks > 0 && gapFraction > tolerance) {
      throw new GroqError(
        describeGroqFailure(
          new Error(
            `${failedChunks} of ${chunks.length} audio chunks failed to transcribe with ` +
            `"${attempt.model}" — too much of the class is missing to report on.`
          ),
          'transcription',
          { model: attempt.model, provider: this.transcriptionProvider.label }
        )
      );
    }

    if (failedChunks > 0) {
      // Remembered so coverage is marked from what actually happened, rather
      // than left to the analysis model noticing the gap markers in the text.
      this.transcriptionGaps += failedChunks;
      logger.error(
        `[GroqTranscriptionService] ${failedChunks}/${chunks.length} chunk(s) could not be transcribed. ` +
        'The transcript has gaps and the report will be built from what was captured.'
      );
    }

    // NOTE: this was `/s{2,}/` — a missing backslash. It collapsed double-s,
    // so every chunked (>24MB) recording had "class" rewritten to "clas" and
    // "business" to "busines" before a single word was analysed.
    /* Joined on NEWLINES, and only spaces are collapsed.
     *
     * Speaker labels live at the START of a line, so flattening the chunks
     * into one long line destroyed every turn boundary: toNumberedTurns saw a
     * single "unknown" turn, evidence could then only cite T001, validation
     * dropped the rest, and a long class came back with empty counts and no
     * assessment. `\s` matches newlines too, so the old collapse undid the
     * structure even once the join was right — hence [ \t] rather than \s. */
    return parts.join('\n').replace(/[ \t]{2,}/g, ' ').trim();
  }

  /** Models that only work on /audio/transcriptions, never on chat. */
  private isDedicatedSttModel(model: string): boolean {
    return /whisper|-transcribe|transcription/i.test(model);
  }

  /**
   * Which wire a model is tried on FIRST.
   *
   * A guess from the model's name, and only a guess — which is why an empty or
   * rejected result falls through to the other wire rather than failing the
   * class. See `buildAttemptLadder`.
   */
  private wirePathFor(model: string): WirePath {
    return this.isDedicatedSttModel(model) ? 'stt' : 'chat';
  }

  /**
   * The size ceiling for one request, which is NOT the same on both wires.
   *
   * `/audio/transcriptions` uploads the file as multipart — the bytes go up
   * as-is. The chat wire base64-encodes the audio into a JSON body, which
   * inflates it by 4/3 before the envelope is even counted. Applying the
   * multipart ceiling to the chat wire let a file pass the check and still be
   * far too large for the provider, which answers 200 with an empty message
   * rather than an error — indistinguishable from "there was nothing to hear".
   *
   * Override with AI_CHAT_AUDIO_MAX_MB when a provider's real inline limit is
   * known; otherwise 70% of the multipart ceiling leaves room for base64.
   */
  private maxBytesFor(wire: WirePath): number {
    if (wire === 'stt') return this.maxUploadBytes;
    const configuredMb = readNumberEnv('AI_CHAT_AUDIO_MAX_MB', 0);
    if (configuredMb > 0) return configuredMb * 1024 * 1024;
    return Math.floor(this.maxUploadBytes * 0.7);
  }

  /**
   * One file, one speech-to-text request.
   *
   * Two wire paths, chosen by the model:
   * - whisper-style models -> POST /audio/transcriptions (multipart). Fast and
   *   cheap, but the transcript has NO speaker labels — attribution is left to
   *   the analysis model's inference.
   * - multimodal chat models (Gemini etc.) -> POST /chat/completions with the
   *   audio inlined. Slower per minute, but the model labels Teacher:/Student:
   *   turns itself and handles Malayalam-English code-switching natively —
   *   which is exactly what fixes a mis-counted "student questions: 0".
   */
  private async uploadForTranscription(
    filePath: string,
    carryOver?: string,
    attempt?: TranscriptionAttempt
  ): Promise<string> {
    const provider = this.transcriptionProvider;
    // The ladder decides the model and wire; without one, fall back to the
    // configured model on the wire its name suggests.
    const model = attempt?.model ?? provider.model;
    const wire = attempt?.wire ?? this.wirePathFor(model);

    if (wire === 'chat') {
      return this.transcribeViaChat(filePath, carryOver, model);
    }

    const formData = new FormData();
    formData.append('model', model);
    formData.append('file', fs.createReadStream(filePath));
    // Whisper's `prompt` biases recognition toward these spellings: the
    // session's own terms first (so "insurance" is never heard as
    // "endurance"), then the previous chunk's tail for continuity. Whisper
    // only reads ~224 tokens of prompt, hence the tight cap.
    const promptParts = [this.transcriptionVocabulary.slice(0, 600), carryOver ?? ''].filter(Boolean);
    if (promptParts.length > 0) formData.append('prompt', promptParts.join('\n'));

    // `language` is worth setting when a class is single-language, but this
    // programme is taught in mixed English and Malayalam. Pinning either one
    // makes Whisper transliterate the other into the pinned script, which
    // destroys the financial vocabulary the report is built from — so the
    // language is left unset unless an operator explicitly forces one.
    const forcedLanguage = readEnv('AI_TRANSCRIPTION_LANGUAGE');
    if (forcedLanguage) formData.append('language', forcedLanguage);

    const startedAt = Date.now();
    try {
      const response = await axios.post(
        `${provider.baseUrl}/audio/transcriptions`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            ...formData.getHeaders(),
          },
          maxBodyLength: Infinity,
          timeout: readNumberEnv('AI_TRANSCRIPTION_TIMEOUT_MS', 600_000),
        },
      );

      // OpenRouter reports { seconds, cost } for transcription requests.
      const usage = response.data?.usage ?? {};
      void recordAiUsage({
        stage: 'transcription',
        provider: provider.label,
        model,
        audioSeconds: Number(usage.seconds) || 0,
        costUsd: Number(usage.cost) || 0,
        processingMs: Date.now() - startedAt,
        ...this.jobTag,
      });

      const text = response.data?.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new EmptyTranscriptError(model, 'stt');
      }
      return text;
    } catch (err: any) {
      // Already typed for the ladder — do not re-wrap it as a transport error.
      if (err instanceof EmptyTranscriptError) throw err;
      // Every failure gets diagnosed once, here, so the message that reaches
      // an operator names the limit that was hit and how to raise it — rather
      // than "Request failed with status code 413".
      const audioMb = fs.existsSync(filePath) ? fs.statSync(filePath).size / (1024 * 1024) : undefined;
      throw new GroqError(
        describeGroqFailure(err, 'transcription', { model, audioMb, provider: provider.label })
      );
    }
  }

  /** Transcription through a multimodal chat model — audio in, labelled text out. */
  private async transcribeViaChat(
    filePath: string,
    carryOver?: string,
    modelOverride?: string
  ): Promise<string> {
    const provider = this.transcriptionProvider;
    const model = modelOverride ?? provider.model;

    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    const format = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'webm'].includes(ext) ? ext : 'mp3';
    const audioBase64 = fs.readFileSync(filePath).toString('base64');

    // The editable transcription prompt (from /prompts), else the code default.
    const activePrompt = await getActivePrompt('transcription');
    if (activePrompt) {
      logger.info(`[GroqTranscriptionService] Using transcription prompt v${activePrompt.version} (from /prompts).`);
    }
    const instructions =
      renderPrompt(activePrompt?.content ?? TRANSCRIPTION_PROMPT_DEFAULT, {
        vocabulary: (this.transcriptionVocabulary || '(none provided)').slice(0, 1500),
        ...this.promptVars,
      }) +
      (carryOver
        ? `\n\nThis audio continues a longer recording. The previous part ended with:\n${carryOver}\nKeep names and spellings consistent with it.`
        : '');

    const startedAt = Date.now();
    try {
      const response = await axios.post(
        `${provider.baseUrl}/chat/completions`,
        {
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: instructions },
                { type: 'input_audio', input_audio: { data: audioBase64, format } },
              ],
            },
          ],
          /* A transcript of a 30-minute class is long, and a reasoning model
           * spends part of this budget thinking before it writes a word. At
           * 16k the budget ran out mid-thought: the provider answered 200 with
           * ~15,99x completion tokens and an EMPTY content field, which read
           * here as "this model heard nothing". Configurable because the right
           * number depends on the model and the class length. */
          max_tokens: readNumberEnv('AI_TRANSCRIPTION_MAX_TOKENS', 32_000),
          temperature: 0,
          usage: { include: true },
          ...providerBodyExtras(provider),
        },
        {
          headers: providerHeaders(provider),
          maxBodyLength: Infinity,
          timeout: readNumberEnv('AI_TRANSCRIPTION_TIMEOUT_MS', 600_000),
        },
      );

      /* Recorded BEFORE the emptiness check, because an empty 200 is a fully
       * billed call — the provider consumed the base64 audio as prompt tokens
       * either way. Throwing first made every losing rung invisible to
       * /costs, so a class could make twenty requests and report one. */
      const usage = response.data?.usage ?? {};
      void recordAiUsage({
        stage: 'transcription',
        provider: provider.label,
        model,
        inputTokens: Number(usage.prompt_tokens) || 0,
        outputTokens: Number(usage.completion_tokens) || 0,
        costUsd: Number(usage.cost) || 0,
        processingMs: Date.now() - startedAt,
        ...this.jobTag,
      });

      const choice = response.data?.choices?.[0];
      const content = choice?.message?.content;
      const finishReason = choice?.finish_reason;
      const completionTokens = Number(usage.completion_tokens) || 0;
      const budget = readNumberEnv('AI_TRANSCRIPTION_MAX_TOKENS', 32_000);

      if (typeof content !== 'string' || content.trim().length === 0) {
        /* Say WHICH kind of nothing this is.
         *
         * "Returned an empty transcript" was true but useless: it reads as
         * "there was no speech" when the actual cause was the output budget
         * running out — a setting, not the audio. finish_reason 'length', or
         * a completion that lands within a whisker of the cap, is the tell.
         * A reasoning model can spend the whole budget thinking and emit no
         * content at all, which is exactly what happened here.
         */
        const hitCap = finishReason === 'length' || completionTokens >= budget * 0.97;
        if (hitCap) {
          throw new GroqError(
            describeGroqFailure(
              new Error(
                `"${model}" used its entire ${budget}-token output budget ` +
                `(${completionTokens} tokens, finish_reason="${finishReason ?? 'unknown'}") without ` +
                'returning any transcript text. The audio is not the problem — the model ran out of ' +
                'room. Raise AI_TRANSCRIPTION_MAX_TOKENS, shorten the chunks with GROQ_CHUNK_SECONDS, ' +
                'or use a dedicated speech-to-text model such as openai/whisper-large-v3-turbo.'
              ),
              'transcription',
              { model, provider: provider.label }
            )
          );
        }

        // Genuinely nothing heard — the ladder may usefully try another model.
        throw new EmptyTranscriptError(model, 'chat');
      }

      /* Truncated, but not empty: keep what came back and say so. Half a
       * lesson analysed knowingly beats half a lesson passed off as whole. */
      if (finishReason === 'length') {
        this.transcriptionGaps += 1;
        logger.error(
          `[GroqTranscriptionService] "${model}" hit its ${budget}-token output limit mid-transcript ` +
          `(${completionTokens} tokens). The transcript is CUT SHORT — coverage will be marked as gaps. ` +
          'Raise AI_TRANSCRIPTION_MAX_TOKENS or lower GROQ_CHUNK_SECONDS.'
        );
      }

      return content.trim();
    } catch (err: any) {
      if (err instanceof GroqError) throw err;
      if (err instanceof EmptyTranscriptError) throw err;
      const audioMb = fs.existsSync(filePath) ? fs.statSync(filePath).size / (1024 * 1024) : undefined;
      throw new GroqError(
        describeGroqFailure(err, 'transcription', { model, audioMb, provider: provider.label })
      );
    }
  }

  /**
   * Cut an audio file into fixed-length pieces with ffmpeg.
   * Returns the chunk paths in order, or an empty array if ffmpeg failed.
   */
  private splitAudio(filePath: string): string[] {
    const ext = path.extname(filePath) || '.mp3';
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, ext);

    /* Chunk names are unique PER RUN.
     *
     * They used to be derived from the audio filename alone, so two
     * transcriptions of the same recording shared every chunk path — and in
     * production the first run to finish cleaned up "its" chunks while the
     * second was still transcribing them. Chunk 4 vanished mid-flight, the
     * report was built from three quarters of the class, and it overwrote the
     * complete report the first run had just written. */
    const runTag = `${process.pid}-${splitRunCounter++}`;
    const prefix = `${base}.${runTag}.chunk-`;
    const pattern = path.join(dir, `${prefix}%03d${ext}`);

    /* The stale sweep is age-based, never name-based. A name match cannot tell
     * a crashed run's leftovers from a concurrent run's live pieces; age can —
     * no transcription holds a chunk for two hours. */
    const STALE_MS = 2 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.chunk-\d+/.test(name)) continue;
      try {
        const full = path.join(dir, name);
        if (Date.now() - fs.statSync(full).mtimeMs > STALE_MS) fs.unlinkSync(full);
      } catch (_) { /* best effort */ }
    }

    const { execFileSync } = require('child_process');
    try {
      execFileSync(
        resolveFfmpeg(),
        ['-y', '-i', filePath, '-f', 'segment', '-segment_time', String(this.chunkSeconds), '-c', 'copy', pattern],
        { stdio: 'pipe' }
      );
    } catch (err: any) {
      logger.error(`[GroqTranscriptionService] ffmpeg could not split the audio: ${err.message}`);
      return [];
    }

    // Sorted, because transcribing chunk 10 before chunk 2 produces a transcript
    // that reads as nonsense — and readdir order is not guaranteed.
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(ext))
      .sort()
      .map((name) => path.join(dir, name));
  }

  /**
   * Deterministic fields the model must never own.
   *
   * The model once echoed the scheduled start straight onto a parent's PDF as
   * a raw ISO string ("2026-08-17T14:00:00.000Z"), and its honest nulls left
   * Duration and Talk time reading "Not available". All three are derivable
   * from data we hold, so they are pinned here AFTER parsing: the narrative
   * stays the model's, the facts are ours.
   *
   * - Start/End: the scheduled class times, formatted in REPORT_TIMEZONE
   *   (default Asia/Kolkata — the families' clock, not the server's).
   * - Duration: the real recording length when known, else the booked slot.
   * - Talk time: the model's attribution when it made one; otherwise the
   *   transcript word-share estimate, spread over the known duration.
   */
  private finalizeReport(
    report: SessionReport,
    context: ClassAnalysisContext,
    talk: { teacherPercent: number | null; studentPercent: number | null; basis: string; label: string }
  ): SessionReport {
    const timeZone = readEnv('REPORT_TIMEZONE') ?? 'Asia/Kolkata';
    const looksIso = (v: string) => /\d{4}-\d{2}-\d{2}T/.test(v);
    const clock = (iso?: string | null): string | null => {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      return new Intl.DateTimeFormat('en-IN', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone,
      }).format(d);
    };

    const start = clock(context.startTime) ?? (looksIso(report.timing.startTime) ? clock(report.timing.startTime) : null);
    if (start) report.timing.startTime = start;
    else if (looksIso(report.timing.startTime)) report.timing.startTime = NOT_AVAILABLE; // never print raw ISO

    const end = clock(context.endTime) ?? (looksIso(report.timing.endTime) ? clock(report.timing.endTime) : null);
    if (end) report.timing.endTime = end;
    else if (looksIso(report.timing.endTime)) report.timing.endTime = NOT_AVAILABLE;

    // Duration: real audio first, booked slot second.
    let seconds: number | null = context.audioSeconds ?? null;
    if (seconds === null && context.startTime && context.endTime) {
      const diff = (new Date(context.endTime).getTime() - new Date(context.startTime).getTime()) / 1000;
      if (Number.isFinite(diff) && diff > 0 && diff < 12 * 3600) seconds = diff;
    }
    if (seconds !== null) {
      const mins = Math.round(seconds / 60);
      report.timing.duration =
        mins >= 60 ? `${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`;
    }

    /* ── Talk time is measured, never negotiated ──────────────────────────
     * Previously the model supplied its own percentages and code filled in
     * only the nulls, so the panel showed a measurement on some runs and a
     * guess on others — with no way to tell which. Code now owns the field
     * outright.
     *
     * The minute figures are only printed when the split came from real
     * TIMESTAMPS. Spreading a word share across the duration is how "Teacher
     * 66m 45s" got onto a parent's PDF as though a stopwatch had been running.
     * ─────────────────────────────────────────────────────────────────── */
    const t = report.talkTime;
    t.teacherPercent = talk.teacherPercent;
    t.studentPercent = talk.studentPercent;
    t.basis = talk.basis as any;
    t.label = talk.label;

    if (seconds !== null && talk.basis === 'timestamps') {
      const mmss = (v: number) => `${Math.floor(v / 60)}m ${String(Math.round(v % 60)).padStart(2, '0')}s`;
      if (t.teacherPercent !== null) t.teacher = mmss((seconds * t.teacherPercent) / 100);
      if (t.studentPercent !== null) t.student = mmss((seconds * t.studentPercent) / 100);
    } else {
      t.teacher = NOT_AVAILABLE;
      t.student = NOT_AVAILABLE;
    }

    return report;
  }

  /**
   * Guarantee the stored transcript names who is speaking.
   *
   * Whisper-style models return unbroken prose with no speaker markers at all,
   * so a class transcribed that way could never yield a talk-time split, and
   * anyone reading it had to guess who said what. Audio-capable chat models
   * label turns themselves; this fills the gap for everything else by running
   * one cheap TEXT pass over the transcript.
   *
   * It is strictly a formatting pass. The instructions forbid changing,
   * summarising or inventing words — if the labelled version comes back with
   * substantially different content, it is discarded and the original stands.
   * A wrongly-labelled transcript is recoverable; a rewritten one is not, and
   * this text is the evidence a parent's report is built from.
   *
   * Failure is never fatal: the original transcript is returned and the report
   * simply reports talk time as "Not available".
   */
  /**
   * Decide which candidate words are actually what the lesson was about.
   *
   * The cloud used to be governed by a hand-maintained blocklist, which is
   * unwinnable: every class produces filler nobody enumerated ("you're",
   * "basically", "discussing", "goes"), those exact words get added, and the
   * next class produces different ones. Inverting it to a strict deck-only
   * allowlist was worse in practice — a real class came back with two words,
   * because a deck names concepts in its own phrasing while a spoken lesson
   * ranges wider.
   *
   * "Is this a concept or a common word?" is a judgement, and a judgement is
   * what a language model is for. So the model prunes — and ONLY prunes:
   *
   *   - It receives the candidate list and returns a subset. Anything it
   *     returns that was not offered is discarded, so it cannot invent
   *     vocabulary the class never used.
   *   - Lesson vocabulary (deck terms, curated financial words) is protected
   *     and re-added even if the model drops it.
   *   - Order and weights are the code's, computed from how often each word
   *     was actually spoken. The model has no say in sizing.
   *   - Any failure keeps the mechanically cleaned candidates minus a short
   *     static filler list. A failure used to keep lesson vocabulary ALONE,
   *     which quietly reproduced the two-word cloud the allowlist experiment
   *     was rejected for: a parent saw "needs - wants - savings" and nothing
   *     else whenever the prune call so much as timed out.
   *   - The model's verdict has a floor (AI_CLOUD_MIN_TERMS, default 18): keep
   *     fewer than that and the strongest cleaned candidates come back in. A
   *     full cloud carrying one ordinary word reads better than three words
   *     on an empty panel.
   *
   * The result is stored with the analysis, so a given class renders the same
   * cloud every time it is opened.
   */
  /**
   * Conversational filler no parent-facing cloud should carry, caught by rule
   * so the FALLBACK cloud is clean too. Deliberately short and unambiguous:
   * lexicon terms bypass it entirely, and a finance lesson's own ordinary
   * words (money, spend, plan, cost) are exactly what must NOT be here —
   * "needs" and "wants" are curriculum in this catalogue, not filler.
   */
  private static readonly CLOUD_FILLER = new Set([
    // Conversational filler and reactions.
    'basically', 'actually', 'literally', 'really', 'okay', 'ok', 'yeah', 'alright',
    'huh', 'umm', 'yep', 'nope', 'wow', 'maybe', 'sure', 'fine', 'totally',
    'gonna', 'wanna', 'getting', 'gets', 'goes', 'going', 'come', 'comes', 'coming',
    'follow', 'follows', 'following', 'easier', 'harder', 'less', 'more', 'most',
    'many', 'much', 'very', 'thing', 'things', 'stuff', 'lot', 'lots', 'kind', 'sort',
    'bit', 'said', 'saying', 'says', 'tell', 'telling', 'told', 'talk', 'talking',
    'talked', 'look', 'looking', 'looked', 'see', 'seeing', 'seen', 'saw',
    'designed', 'discussing', 'discussed', 'building', 'built', 'fair', 'nice',
    'good', 'great', 'better', 'best', 'little', 'big', 'small', 'different',
    'example', 'examples',
    // Vague connectives and quantifiers real clouds carried: "whole",
    // "whatever", "else", "through" tell a parent nothing about the lesson.
    'whatever', 'whole', 'else', 'through', 'depends', 'depend', 'anyway',
    'anything', 'something', 'everything', 'nothing', 'someone', 'everyone',
    'somebody', 'anybody', 'clear', 'clearly', 'clueless', 'live',
    'today', 'tomorrow', 'yesterday',
    // Words about the CLASS rather than its subject. A cloud that says
    // "session, course, doubts, learned" describes every lesson ever taught.
    'class', 'classes', 'session', 'sessions', 'course', 'courses', 'lesson',
    'lessons', 'doubt', 'doubts', 'attend', 'attended', 'attending',
    'learn', 'learned', 'learning',
    'explain', 'explains', 'explained', 'explaining', 'asking', 'asked', 'asks',
    'answer', 'answers', 'answered', 'question', 'questions', 'speak', 'speaking',
    'spoke', 'listen', 'listening', 'understand', 'understood', 'remember',
    'remembered', 'repeat', 'share', 'shared', 'liked', 'likes',
    // Address words — a child calling someone is not vocabulary.
    'sis', 'bro', 'mom', 'dad', 'mum', 'sir', 'madam', 'miss', 'dear', 'buddy',
  ]);

  /**
   * The cloud when the model's judgement is unavailable or unusable.
   *
   * Not lexicon-only: session-evidence records that a strict deck gate
   * produced a two-word cloud for a real class, and the lexicon-only fallback
   * was the same gate wearing a different name. The candidates arriving here
   * have already been mechanically cleaned — stopwords, contractions, proper
   * nouns, the said-twice floor — so they are presentable; this subtracts only
   * the known filler the AI pass exists to catch.
   */
  private cloudFallback(candidates: WordCloudEntry[]): WordCloudEntry[] {
    return candidates
      .filter((c) => c.inLexicon || !GroqTranscriptionService.CLOUD_FILLER.has(c.word.toLowerCase()))
      .slice(0, CLOUD_MAX_TERMS);
  }

  private async pruneWordCloud(
    candidates: WordCloudEntry[],
    context: { sessionTitle: string | null; plannedTopics: string[] }
  ): Promise<WordCloudEntry[]> {
    if (candidates.length === 0) return candidates;

    const fallback = this.cloudFallback(candidates);

    /* Nothing to prune. When the pool is already at or under the floor, the
     * model can only shrink a cloud that is too small — so it is not asked. */
    if (candidates.length <= readNumberEnv('AI_CLOUD_MIN_TERMS', 18)) {
      return fallback;
    }

    if (!this.hasAnalysisKey) {
      logger.warn('[GroqTranscriptionService] No analysis key — keeping the rule-cleaned candidates in the word cloud.');
      return fallback;
    }

    const provider = this.analysisProvider;
    const offered = candidates.map((c) => c.word);

    const instructions = [
      'You are cleaning the word cloud for a parent-facing report about a school lesson.',
      context.sessionTitle ? `The lesson was: "${context.sessionTitle}".` : '',
      context.plannedTopics.length > 0 ? `Planned topics: ${context.plannedTopics.join(', ')}.` : '',
      '',
      'Below is a list of words counted from the lesson transcript. Keep the words a parent would',
      'recognise as the vocabulary OF THIS LESSON; remove everything that merely happened to be said.',
      '',
      'The test for each word: would a parent, reading this cloud alone, connect it to what their',
      'child was taught? If not, remove it.',
      '',
      'REMOVE:',
      '  - conversation filler and reactions: basically, actually, huh, yeah, okay, whatever, sure',
      '  - vague connectives and quantifiers: whole, else, through, depends, something, anything',
      '  - words about the class itself rather than its subject: session, course, doubts, attended,',
      '    learned, explain, asking, answered, speak, liked',
      '  - words addressing a person: sis, bro, sir, madam',
      '  - generic verbs and adjectives any lesson would contain: designed, discussing, building, fair',
      '  - any word containing an apostrophe, and fragments of contractions',
      '',
      'KEEP:',
      '  - ordinary words this lesson is about (money, needs, wants, cost, plan, habit, rule)',
      '  - concrete examples and categories compared, chosen between or budgeted for — food, clothes,',
      '    shelter, toys, pocket money are exactly what belongs',
      '  - words naming amounts, choices or decisions within the subject',
      '',
      'There is no target count. Fifteen genuinely topical words read better than thirty with chatter',
      'mixed in — but do not strip the list to headline terms either; the concrete examples above are',
      'the texture a parent wants to see.',
      '',
      'Return JSON only: {"keep": ["word", "word", ...]}. Copy words EXACTLY as given, character for',
      'character. Do not add words that are not in the list. Do not reorder by importance.',
      '',
      'WORDS:',
      offered.map((w) => `- ${w}`).join(NEWLINE),
    ]
      .filter(Boolean)
      .join(NEWLINE);

    const startedAt = Date.now();
    try {
      const response = await axios.post(
        `${provider.baseUrl}/chat/completions`,
        {
          model: provider.model,
          messages: [{ role: 'user', content: instructions }],
          response_format: { type: 'json_object' },
          ...MODEL_CALL_DEFAULTS,
          max_tokens: 1500,
          usage: { include: true },
          ...providerBodyExtras(provider),
        },
        {
          headers: providerHeaders(provider),
          timeout: readNumberEnv('AI_CLOUD_PRUNE_TIMEOUT_MS', 60_000),
        },
      );

      const usage = response.data?.usage ?? {};
      void recordAiUsage({
        stage: 'analysis',
        provider: provider.label,
        model: provider.model,
        inputTokens: Number(usage.prompt_tokens) || 0,
        outputTokens: Number(usage.completion_tokens) || 0,
        costUsd: Number(usage.cost) || 0,
        processingMs: Date.now() - startedAt,
        ...this.jobTag,
      });

      const parsed = this.parseJson(response.data?.choices?.[0]?.message?.content ?? '');
      const keepRaw = Array.isArray(parsed?.keep) ? parsed.keep : null;
      if (!keepRaw) {
        logger.warn('[GroqTranscriptionService] Word-cloud prune returned no usable list — keeping the rule-cleaned candidates.');
        return fallback;
      }

      // Matched case-insensitively but only against what was OFFERED, so the
      // model can subtract and never add.
      const keep = new Set(keepRaw.map((w: unknown) => String(w ?? '').trim().toLowerCase()));
      const kept = candidates.filter((c) => keep.has(c.word.toLowerCase()) || c.inLexicon);

      const removed = candidates.length - kept.length;
      if (kept.length === 0) {
        logger.warn('[GroqTranscriptionService] Word-cloud prune removed everything — keeping the rule-cleaned candidates instead.');
        return fallback;
      }

      /* The floor. A prune that keeps three words is not judgement, it is a
       * broken cloud — and "keep about thirty" in the prompt does not bind a
       * model having a bad day. Below the floor, the strongest cleaned
       * candidates come back in (filler still excluded), then the whole set is
       * re-ranked to the candidates' original frequency order so sizing stays
       * honest. */
      const minTerms = Math.min(readNumberEnv('AI_CLOUD_MIN_TERMS', 18), candidates.length);
      let survivors = [...kept];
      if (survivors.length < minTerms) {
        const have = new Set(survivors.map((c) => c.word.toLowerCase()));
        for (const c of this.cloudFallback(candidates)) {
          if (survivors.length >= minTerms) break;
          const key = c.word.toLowerCase();
          if (!have.has(key)) {
            have.add(key);
            survivors.push(c);
          }
        }
        survivors = candidates.filter((c) => have.has(c.word.toLowerCase()));
        logger.info(
          `[GroqTranscriptionService] Word-cloud prune kept only ${kept.length} — topped up to ${survivors.length} from the cleaned candidates.`
        );
      }

      /* Trimmed to the panel's capacity only NOW.
       *
       * Trimming before the prune wasted slots on filler: thirty candidates in,
       * a third of them noise, and the parent saw twenty words. Pruning first
       * means every one of the thirty shown earned its place. */
      const finalCloud = survivors.slice(0, CLOUD_MAX_TERMS);
      logger.info(
        `[GroqTranscriptionService] Word cloud pruned: ${candidates.length} candidate(s) -> ${survivors.length} concept(s)` +
        `${removed > 0 ? ` (${removed} common word(s) removed)` : ''}` +
        `${survivors.length > finalCloud.length ? `, showing the top ${finalCloud.length}` : ''}.`
      );
      return finalCloud;
    } catch (err: any) {
      logger.warn(
        `[GroqTranscriptionService] Word-cloud prune failed (${err.message}) — keeping the rule-cleaned candidates.`
      );
      return fallback;
    }
  }

  private async ensureSpeakerLabels(
    transcript: string,
    studentName: string,
    mentorName: string
  ): Promise<string> {
    if (!transcript || transcript.trim().length === 0) return transcript;

    // Already labelled? Then the transcription model did the job — leave it.
    // Judged on TURNS now: a transcript is labelled when both speakers appear,
    // which is the same condition talk time needs.
    const probe = toNumberedTurns(transcript, studentName, mentorName);
    const bothSpeakers =
      probe.some((t) => t.speaker === 'teacher') && probe.some((t) => t.speaker === 'student');
    if (bothSpeakers) return transcript;

    if (!this.hasAnalysisKey) {
      logger.warn(
        '[GroqTranscriptionService] Transcript has no speaker labels and no analysis key is set, ' +
        'so it cannot be labelled. Talk time will read "Not available".'
      );
      return transcript;
    }

    const system =
      `You label who is speaking in a transcript of a 1:1 online class. One adult TEACHER ` +
      `(${mentorName}) teaches one child STUDENT (${studentName}).\n\n` +
      `Rewrite the transcript as one line per speaking turn, each line starting with exactly ` +
      `"Teacher:" or "Student:".\n\n` +
      `ABSOLUTE RULES — this is a formatting pass, not an edit:\n` +
      `1. Reproduce every word exactly as given. Never translate, summarise, correct, shorten or add anything.\n` +
      `2. Preserve the original language and script, including Malayalam.\n` +
      `3. Keep any [mm:ss] timestamps, immediately after the label.\n` +
      `4. Decide the speaker from the content: the teacher explains, asks questions and uses the child's ` +
      `name; the student answers, asks back, and says short things like "yes", "okay", "mm-hmm".\n` +
      `5. When a stretch is genuinely ambiguous, attach it to the speaker of the previous turn rather ` +
      `than guessing a new one.\n` +
      `6. Output ONLY the labelled transcript lines. No preamble, no commentary, no code fences.`;

    /* Chunked so a long class fits the model's context, split on sentence
     * boundaries so a turn is not cut mid-thought. The tail of the previous
     * chunk rides along as context so the speaker carries across the seam. */
    const chunkChars = readNumberEnv('AI_LABEL_CHUNK_CHARS', 12_000);
    const chunks: string[] = [];
    for (let i = 0; i < transcript.length; i += chunkChars) {
      chunks.push(transcript.slice(i, i + chunkChars));
    }

    logger.info(
      `[GroqTranscriptionService] Transcript has no speaker labels — labelling it in ` +
      `${chunks.length} pass(es) so talk time and the transcript view name who is speaking.`
    );

    const provider = this.analysisProvider;
    const labelled: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const previousTail = labelled.length > 0 ? labelled[labelled.length - 1].slice(-400) : '';
      const user =
        (previousTail
          ? `The previous part ended like this (for speaker continuity only — do NOT repeat it):\n${previousTail}\n\n`
          : '') + `TRANSCRIPT PART ${i + 1} OF ${chunks.length}:\n${chunks[i]}`;

      const startedAt = Date.now();
      try {
        const response = await axios.post(
          `${provider.baseUrl}/chat/completions`,
          {
            model: provider.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0,
            max_tokens: 8000,
            usage: { include: true },
            ...providerBodyExtras(provider),
          },
          { headers: providerHeaders(provider), timeout: readNumberEnv('GROQ_SUMMARY_TIMEOUT_MS', 180_000) }
        );

        const usage = response.data?.usage ?? {};
        void recordAiUsage({
          stage: 'analysis',
          provider: provider.label,
          model: provider.model,
          inputTokens: Number(usage.prompt_tokens) || 0,
          outputTokens: Number(usage.completion_tokens) || 0,
          costUsd: Number(usage.cost) || 0,
          processingMs: Date.now() - startedAt,
          ...this.jobTag,
        });

        const content = response.data?.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
          labelled.push(content.trim());
        } else {
          logger.warn(`[GroqTranscriptionService] Labelling pass ${i + 1} returned nothing — keeping that part unlabelled.`);
          labelled.push(chunks[i]);
        }
      } catch (err: any) {
        logger.warn(
          `[GroqTranscriptionService] Labelling pass ${i + 1} failed: ${err.message}. ` +
          'Keeping that part of the transcript unlabelled.'
        );
        labelled.push(chunks[i]);
      }
    }

    const result = labelled.join('\n');

    /* Guard against a model that "helpfully" summarised instead of labelling.
     * Word count is the cheap, language-agnostic check: labels ADD words, so a
     * genuine labelling pass never comes back much shorter than the original. */
    const originalWords = transcript.split(/\s+/).filter(Boolean).length;
    const labelledWords = result.split(/\s+/).filter(Boolean).length;
    if (originalWords > 0 && labelledWords < originalWords * 0.7) {
      logger.error(
        `[GroqTranscriptionService] The labelling pass returned ${labelledWords} words for an ` +
        `${originalWords}-word transcript — it rewrote rather than labelled. Discarding it and ` +
        'keeping the original transcript.'
      );
      return transcript;
    }

    const after = deriveTalkShare(toNumberedTurns(result, studentName, mentorName));
    if (after.basis === 'unmeasurable') {
      logger.warn('[GroqTranscriptionService] Labelling did not produce usable speaker labels — keeping the original.');
      return transcript;
    }

    logger.info(
      `[GroqTranscriptionService] Transcript labelled: teacher ${after.teacherPercent}% / ` +
      `student ${after.studentPercent}% (${after.label.toLowerCase()}).`
    );
    return result;
  }

  /**
   * How much of the transcript the summariser actually reads.
   *
   * This was a hard `slice(0, 12000)`. At ~130 words a minute a 90-minute class
   * transcribes to roughly 70,000 characters, so 12,000 was the FIRST FIFTEEN
   * MINUTES and nothing else. Every summary was written from the opening of the
   * lesson: the homework section had to be invented or left empty, because
   * homework is set at the end of a class and the model never saw it.
   *
   * Retained ONLY for the legacy free-text summary below. The v2 analysis path
   * uses `turnsForPrompt`, which drops whole turns rather than cutting a
   * sentence in half.
   */
  private transcriptForPrompt(transcript: string): string {
    const limit = readNumberEnv('GROQ_SUMMARY_TRANSCRIPT_CHARS', 120_000);
    if (transcript.length <= limit) return transcript;

    // Keep the opening (what the class was about) and the ending (what was set
    // as homework), and say plainly that the middle was dropped so the model
    // does not narrate over a gap it cannot see.
    const head = Math.floor(limit * 0.55);
    const tail = limit - head;
    logger.warn(
      `[GroqTranscriptionService] Transcript is ${transcript.length} chars, over the ${limit} limit — ` +
      'summarising the opening and the closing, with the middle omitted.'
    );
    return (
      `${transcript.slice(0, head)}\n\n[... middle of the session omitted for length ...]\n\n${transcript.slice(-tail)}`
    );
  }

  /**
   * Everything one analysed class produces internally.
   *
   * The report is what a parent sees; the envelope carries the internal flags
   * and the raw evidence, which is what the QA report and the /errors page are
   * built from.
   */
  private static readonly ANALYSIS_STAGE = 'analysis' as const;

  /**
   * Pull this session's own terms out of the deck.
   *
   * Feeds `buildSessionLexicon`, which becomes the closed list the model may
   * select concepts from. Without it, the model names concepts freely and the
   * word cloud changes shape every run — "impulse buying" one time, "impulsive
   * purchase" the next, and `normalizeCloudWord` can only collapse plurals.
   */
  private deckTerms(context: ClassAnalysisContext): string[] {
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
    return terms;
  }

  /**
   * How much of the transcript the analyser reads.
   *
   * This was a hard `slice(0, 12000)` — the FIRST FIFTEEN MINUTES of a
   * 90-minute class and nothing else, which is why homework had to be invented
   * or left empty: homework is set at the end and the model never saw it.
   *
   * Now it drops whole TURNS from the middle rather than cutting mid-sentence,
   * and keeps the tail, because the close of a lesson carries the homework and
   * the next steps — the part a parent acts on.
   */
  private turnsForPrompt(turns: Turn[]): { turns: Turn[]; complete: boolean } {
    const limit = readNumberEnv('GROQ_SUMMARY_TRANSCRIPT_CHARS', 120_000);
    const size = (list: Turn[]) => list.reduce((sum, t) => sum + t.text.length + 24, 0);
    if (size(turns) <= limit) return { turns, complete: true };

    const head: Turn[] = [];
    const tail: Turn[] = [];
    let headSize = 0;
    let tailSize = 0;
    const headBudget = Math.floor(limit * 0.55);

    for (const turn of turns) {
      if (headSize + turn.text.length > headBudget) break;
      head.push(turn);
      headSize += turn.text.length + 24;
    }
    for (let i = turns.length - 1; i >= head.length; i--) {
      if (tailSize + turns[i].text.length > limit - headSize) break;
      tail.unshift(turns[i]);
      tailSize += turns[i].text.length + 24;
    }

    logger.warn(
      `[GroqTranscriptionService] Transcript is ${size(turns).toLocaleString()} chars, over the ` +
      `${limit.toLocaleString()} limit — analysing the opening and the closing, ` +
      `${turns.length - head.length - tail.length} turn(s) omitted from the middle.`
    );
    return { turns: [...head, ...tail], complete: false };
  }

  /**
   * Analyse the recording against the session material.
   *
   * ── Two inputs, two different jobs ──
   * The MATERIAL says what was PLANNED. The RECORDING says what HAPPENED.
   * Keeping that distinction sharp is the whole game: given curriculum text, a
   * language model will happily describe the lesson as designed and hand a
   * parent a report about concepts their child never reached. So the material
   * is scoped to naming, spelling and coverage, and every claim about the CHILD
   * must cite a turn.
   *
   * ── Why an envelope and not a SessionReport ──
   * The model used to return the report itself, which meant it owned the counts,
   * the percentages, the status bands and the cloud weights at the same time as
   * the prose. Those are the fields that moved between runs. It now returns
   * evidence and narrative; `deriveMetrics` and `buildSessionReport` do the rest.
   */
  private async generateSessionReport(
    turns: Turn[],
    studentName: string,
    mentorName: string,
    context: ClassAnalysisContext
  ): Promise<{ report: SessionReport; envelope: AnalysisEnvelope }> {
    const slides = (context.slideContent ?? '').trim();
    const slideLimit = readNumberEnv('GROQ_SLIDE_CONTENT_CHARS', 40_000);
    const slideBlock = slides
      ? slides.slice(0, slideLimit)
      : '(No session material was provided. Derive the learning goals and topics from the recording alone, and keep them conservative.)';

    const lexicon = buildSessionLexicon(this.deckTerms(context));
    const plannedTopics = (context.plannedTopics ?? []).filter(Boolean);

    const durationHint = context.audioSeconds
      ? `The recording is ${Math.round(context.audioSeconds)} seconds long (${Math.floor(context.audioSeconds / 60)}m ${Math.round(context.audioSeconds % 60)}s).`
      : 'The exact recording length is unknown.';

    const active = await getActivePrompt('analysis');
    if (active) {
      logger.info(`[GroqTranscriptionService] Using analysis prompt v${active.version} (from /prompts).`);
    }
    const systemPrompt = buildAnalysisSystemPrompt(
      active?.content ?? ANALYSIS_PROMPT_DEFAULT,
      { duration_hint: durationHint },
      lexicon
    );

    const { turns: readable, complete } = this.turnsForPrompt(turns);

    const userPrompt = `STUDENT: ${studentName}
TEACHER: ${mentorName}
SESSION: ${context.sessionTitle ?? 'Not available'}${context.sessionOrder ? ` (Session ${context.sessionOrder}${context.sessionTotal ? ` of ${context.sessionTotal}` : ''})` : ''}
DATE: ${context.classDate ?? 'Not available'}
${plannedTopics.length > 0 ? `PLANNED TOPICS: ${plannedTopics.join('; ')}` : ''}

===== INPUT 1 — SESSION MATERIAL (what was PLANNED) =====
${slideBlock}

===== INPUT 2 — SESSION TRANSCRIPT (what actually HAPPENED) =====
${renderTurns(readable)}
===== END OF TRANSCRIPT =====

Return the JSON object now.`;

    const send = this.buildSender();

    const budget = readNumberEnv('GROQ_MAX_REQUEST_TOKENS', 0);
    const singleShotTokens = estimateTokens(systemPrompt + userPrompt) + 6000;

    let envelope: AnalysisEnvelope;
    let passes = 1;

    if (budget > 0 && singleShotTokens > budget) {
      /* ── Too big for one request ──────────────────────────────────────────
       * On the Groq FREE tier `openai/gpt-oss-120b` allows 8,000 tokens per
       * MINUTE. That is a spend ceiling, not a context ceiling — the model
       * holds 131,072 — so a 90-minute class is refused with 413 even though
       * it would fit comfortably in the window.
       * ─────────────────────────────────────────────────────────────────── */
      logger.info(
        `[GroqTranscriptionService] The class needs about ${singleShotTokens.toLocaleString()} tokens, over the ` +
        `${budget.toLocaleString()}-token per-request budget. Reading it in passes.`
      );
      const passResult = await this.analyseInPasses(turns, slideBlock, lexicon, studentName, mentorName, context, budget, durationHint, send);
      envelope = passResult.envelope;
      passes = passResult.passes;
    } else {
      envelope = parseAnalysisEnvelope(await this.sendJson(send, systemPrompt, userPrompt));
    }

    if (!complete && envelope.coverageNote === 'full') envelope.coverageNote = 'partial';

    /* Chunks that never transcribed are missing minutes of the lesson, and the
     * report must say so. Previously this rested on the analysis model reading
     * the gap markers in the transcript and choosing to set coverageNote
     * itself — a judgement, not a guarantee, so a class could be assessed on a
     * fraction of itself and still be stamped complete. */
    if (this.transcriptionGaps > 0 && envelope.coverageNote === 'full') {
      envelope.coverageNote = 'gaps';
      logger.warn(
        `[GroqTranscriptionService] Coverage marked "gaps": ${this.transcriptionGaps} audio chunk(s) ` +
        'never transcribed, so part of this class was never analysed.'
      );
    }

    /* ── Every number on the report is computed here ──────────────────────── */
    const derived = deriveMetrics(envelope, turns, lexicon, [studentName, mentorName]);
    const talk = deriveTalkShare(turns, context.audioSeconds ?? null);

    /* The cloud arrives as frequency-ranked candidates; a model decides which
     * of them are actually what the lesson was about. See `pruneWordCloud`. */
    derived.wordCloud = await this.pruneWordCloud(derived.wordCloud, {
      sessionTitle: context.sessionTitle ?? null,
      plannedTopics: context.plannedTopics ?? [],
    });

    if (derived.discarded > 0) {
      // The most useful health signal this pipeline emits. A model padding its
      // evidence cites loosely, and every loose citation lands here instead of
      // in a count. A steady climb means the prompt is drifting.
      logger.warn(
        `[GroqTranscriptionService] ${derived.discarded} evidence item(s) were discarded — they cited a turn ` +
        'that does not exist or belongs to the other speaker. High values mean the model is padding.'
      );
    }

    const meta: SessionReportMeta = {
      suiteVersion: PROMPT_SUITE_VERSION,
      fingerprint: analysisFingerprint({
        transcript: renderTurns(turns),
        slideContent: slideBlock,
        model: this.summaryModel,
        studentName,
      }),
      model: this.summaryModel,
      coverage: envelope.coverageNote,
      passes,
      discardedEvidence: derived.discarded,
    };

    const report = buildSessionReport(envelope, derived, talk, {
      student: studentName,
      teacher: mentorName,
      sessionTopic: context.sessionTitle ?? NOT_AVAILABLE,
      weekNumber: context.sessionOrder ?? null,
      weekTotal: context.sessionTotal ?? null,
      date: context.classDate ?? NOT_AVAILABLE,
      timing: { startTime: NOT_AVAILABLE, endTime: NOT_AVAILABLE, duration: NOT_AVAILABLE },
      meta,
    });

    /* ── Coverage is an OPERATIONAL fact, not a parent-facing one ──────────
     * This used to prefix parentSummary with "[Based on part of the recording
     * only — the full class could not be analysed on the current AI plan.]",
     * which put our billing tier on a customer's document. It is now an
     * internal flag, and the report is held by the caller.
     * ─────────────────────────────────────────────────────────────────── */
    if (envelope.coverageNote !== 'full') {
      envelope.internalFlags.push({
        kind: 'content_gap',
        turn: null,
        note:
          envelope.coverageNote === 'partial'
            ? 'Only part of the recording was analysed (transcript exceeded the per-request budget). Report needs a human read before sending.'
            : 'The transcript contained gaps (failed chunks or inaudible stretches).',
      });
    }

    logger.info(
      `[GroqTranscriptionService] Session report built in ${passes} pass(es) — ` +
      `${report.learningGoals.length} goal(s), ${report.topicsCovered.length} topic(s) covered, ` +
      `${report.topicsNotReached.length} not reached, ${report.wordCloud.length} concept(s), ` +
      `${derived.interactions.teacherQuestions} teacher question(s), ` +
      `${derived.interactions.studentQuestions} student question(s)` +
      `${slides ? '' : ' (NO session material was available)'} [coverage: ${envelope.coverageNote}].`
    );

    return { report, envelope };
  }

  /** Parse a model reply that should be JSON, tolerating a fenced block. */
  private parseJson(content: string): any {
    /* The second attempt here used to be a bare JSON.parse on the extracted
     * object, so a model that dropped ONE comma between two array elements
     * escaped as a raw SyntaxError — "Expected ',' or ']' after array element
     * at position 6988" — and abandoned a recording whose transcript had
     * already succeeded. Syntax slips are repaired; only genuinely
     * unparseable output is refused, and as a GroqError the caller can act on. */
    const repaired = parseRepairedJson(content);
    if (!repaired) {
      throw new GroqError(
        describeGroqFailure(new Error('The analysis model did not return parseable JSON.'), 'analysis', {
          model: this.summaryModel,
          provider: this.analysisProvider.label,
        })
      );
    }
    if (repaired.repair !== 'none') {
      logger.warn(
        `[GroqTranscriptionService] Analysis JSON needed a ${repaired.repair} repair before it parsed ` +
        `(${this.summaryModel}). The content is unchanged; only punctuation was fixed.`
      );
    }
    return repaired.value;
  }

  /**
   * Send one analysis request and parse its JSON — asking a second time if
   * the first answer cannot be parsed even after repair. Models are not
   * deterministic about punctuation; a re-ask is cheap, an abandoned class
   * is not.
   */
  private async sendJson(
    send: (system: string, user: string) => Promise<string>,
    system: string,
    user: string
  ): Promise<any> {
    try {
      return this.parseJson(await send(system, user));
    } catch (err: any) {
      if (!/parseable JSON/.test(String(err?.message))) throw err;
      logger.warn('[GroqTranscriptionService] Analysis JSON was unparseable — asking the model once more.');
      return this.parseJson(
        await send(system, `${user}\n\nReturn ONLY a single valid JSON object. No prose, no code fence, no trailing commas.`)
      );
    }
  }

  /**
   * One analysis request.
   *
   * `MODEL_CALL_DEFAULTS` replaces the old `temperature: 0.2`. Temperature 0.2
   * is not "slightly creative" on an extraction task; it is a licence to
   * sample different evidence, which is half of why two runs over the same
   * audio disagreed.
   */
  private buildSender(): (system: string, user: string) => Promise<string> {
    return async (system: string, user: string) => {
      const requestTokens = estimateTokens(system + user) + 6000;
      logger.info(
        `[GroqTranscriptionService] Sending analysis to ${this.analysisProvider.label} ` +
        `(${this.summaryModel}) — about ${requestTokens.toLocaleString()} tokens.`
      );

      const provider = this.analysisProvider;
      const startedAt = Date.now();

      try {
        const response = await axios.post(
          `${provider.baseUrl}/chat/completions`,
          {
            model: provider.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 6000,
            ...MODEL_CALL_DEFAULTS,
            // OpenRouter includes its own cost accounting when asked; other
            // vendors ignore the field.
            usage: { include: true },
            ...providerBodyExtras(provider),
          },
          {
            headers: providerHeaders(provider),
            timeout: readNumberEnv('GROQ_SUMMARY_TIMEOUT_MS', 180_000),
          },
        );

        const usage = response.data?.usage ?? {};
        void recordAiUsage({
          stage: 'analysis',
          provider: provider.label,
          model: provider.model,
          inputTokens: Number(usage.prompt_tokens) || 0,
          outputTokens: Number(usage.completion_tokens) || 0,
          costUsd: Number(usage.cost) || 0,
          processingMs: Date.now() - startedAt,
          ...this.jobTag,
        });

        const content = response.data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new GroqError(
            describeGroqFailure(new Error(`"${this.summaryModel}" returned an empty message.`), 'analysis', {
              model: this.summaryModel,
              provider: this.analysisProvider.label,
            })
          );
        }
        return content;
      } catch (err: any) {
        if (err instanceof GroqError) throw err;
        throw new GroqError(
          describeGroqFailure(err, 'analysis', {
            model: this.summaryModel,
            requestTokens,
            provider: this.analysisProvider.label,
          })
        );
      }
    };
  }

  /**
   * Analyse a class too large for one request, in passes.
   *
   * ── What changed ──
   * The old version asked each slice for its own INTEGERS and summed them with
   * `sumCounts`. Two consequences: a slice boundary landing mid-exchange
   * counted the same question twice, and the pass path could never agree with
   * the single-shot path because they were answering different questions.
   *
   * Now each pass returns turn-anchored EVIDENCE, `mergeEnvelopes` dedupes on
   * turn id, and `deriveMetrics` counts once. Slices are cut on turn boundaries
   * with a two-turn overlap, which is safe precisely because of that dedupe.
   * The two paths converge on the same numbers for the same recording, which is
   * the property this whole rework exists for.
   *
   * The cost is wall-clock: passes are paced against tokens-per-minute, so a
   * 90-minute class takes six or seven minutes. That is free in practice —
   * this runs in the background and nobody is waiting on it. It is still a
   * workaround for a plan limit, not an improvement: a single pass sees the
   * whole conversation and can reason across it.
   */
  private async analyseInPasses(
    turns: Turn[],
    slideBlock: string,
    lexicon: string[],
    studentName: string,
    mentorName: string,
    context: ClassAnalysisContext,
    budget: number,
    durationHint: string,
    send: (system: string, user: string) => Promise<string>
  ): Promise<{ envelope: AnalysisEnvelope; passes: number }> {
    const slideOutline = condenseSlides(slideBlock);
    const passSystem = buildPassSystemPrompt(lexicon);

    const perPassOverhead = estimateTokens(passSystem + slideOutline) + 900; /* reply */
    const transcriptTokensPerPass = Math.max(1200, budget - perPassOverhead);
    const charsPerPass = Math.floor(transcriptTokensPerPass * 3.6);

    let slices = sliceByTurns(turns, charsPerPass, 2);

    const maxPasses = readNumberEnv('GROQ_MAX_ANALYSIS_PASSES', 12);
    let coverage: AnalysisEnvelope['coverageNote'] = 'full';
    if (slices.length > maxPasses) {
      // Keep the beginning and the end: the opening establishes the topic, the
      // close carries the homework and the next steps.
      const keepHead = Math.ceil(maxPasses / 2);
      const keepTail = maxPasses - keepHead;
      logger.warn(
        `[GroqTranscriptionService] ${slices.length} passes needed but the ceiling is ${maxPasses}. ` +
        'Reading the opening and the closing; the middle will be skipped and the report marked partial.'
      );
      slices = [...slices.slice(0, keepHead), ...slices.slice(slices.length - keepTail)];
      coverage = 'partial';
    }

    logger.info(
      `[GroqTranscriptionService] Reading the class in ${slices.length} pass(es) of ~${charsPerPass.toLocaleString()} characters.`
    );

    const parts: AnalysisEnvelope[] = [];
    const pacer = new TpmPacer(budget);

    for (let i = 0; i < slices.length; i++) {
      const user = `SESSION MATERIAL (for naming and spelling only — never treat as taught):
${slideOutline}

TRANSCRIPT SLICE ${i + 1} OF ${slices.length}:
${renderTurns(slices[i])}

Return the JSON now.`;

      await pacer.waitFor(estimateTokens(passSystem + user) + 900);

      try {
        parts.push(parseAnalysisEnvelope(await this.sendJson(send, passSystem, user)));
        logger.info(`[GroqTranscriptionService] Pass ${i + 1}/${slices.length} complete.`);
      } catch (err: any) {
        // One bad slice must not cost the whole report — but it must not be
        // silent either. A failed pass is missing evidence, and missing
        // evidence looks exactly like a quiet child.
        logger.error(`[GroqTranscriptionService] Pass ${i + 1} failed: ${err.message}. Continuing without it.`);
        coverage = 'gaps';
      }
    }

    if (parts.length === 0) {
      throw new GroqError(
        describeGroqFailure(new Error('Every analysis pass failed.'), 'analysis', {
          model: this.summaryModel,
          provider: this.analysisProvider.label,
        })
      );
    }

    const merged = mergeEnvelopes(parts);
    if (coverage !== 'full') merged.coverageNote = coverage;

    /* ── Reduce: evidence -> narrative ──────────────────────────────────────
     * The reducer is shown the metrics ALREADY COMPUTED from the merged
     * evidence and told they are final. It writes prose around fixed numbers
     * rather than producing its own, which is what stops the pass path and the
     * single-shot path from telling a parent two different stories.
     * ─────────────────────────────────────────────────────────────────── */
    const interim = deriveMetrics(merged, turns, lexicon, [studentName, mentorName]);

    const reduceUser = `STUDENT: ${studentName}
TEACHER: ${mentorName}
SESSION: ${context.sessionTitle ?? 'Not available'}${context.sessionOrder ? ` (Session ${context.sessionOrder}${context.sessionTotal ? ` of ${context.sessionTotal}` : ''})` : ''}
DATE: ${context.classDate ?? 'Not available'}

===== SESSION MATERIAL (what was PLANNED) =====
${slideOutline}

===== FINAL METRICS (already computed — do not restate or contradict) =====
${JSON.stringify(interim.interactions, null, 1)}
Concepts confirmed taught: ${interim.wordCloud.map((w) => w.word).join(', ') || '(none)'}
Homework set: ${interim.homework.join(' | ') || '(none)'}

===== EVIDENCE FROM THE WHOLE RECORDING =====
${JSON.stringify(interim.evidence, null, 1)}

===== INTERNAL FLAGS (so you know what NOT to write) =====
${JSON.stringify(merged.internalFlags, null, 1)}

Anything in the session material that does not appear in the evidence belongs in topicsNotReached.

Return the JSON object now.`;

    const active = await getActivePrompt('analysis');
    const reduceSystem = buildReduceSystemPrompt(
      active?.content ?? ANALYSIS_PROMPT_DEFAULT,
      { duration_hint: durationHint },
      lexicon
    );

    await pacer.waitFor(estimateTokens(reduceSystem + reduceUser) + 6000);
    const narrative = parseAnalysisEnvelope(await this.sendJson(send, reduceSystem, reduceUser));
    merged.narrative = narrative.narrative;

    logger.info(
      `[GroqTranscriptionService] Multi-pass evidence merged from ${parts.length} pass(es) — ` +
      `${interim.interactions.teacherQuestions} teacher question(s), ${interim.wordCloud.length} concept(s).`
    );

    return { envelope: merged, passes: parts.length + 1 };
  }

  /**
   * The previous free-text summary. Unused by the pipeline since the structured
   * report replaced it, and kept only because `GROQ_LEGACY_SUMMARY=true` is a
   * one-line escape hatch if the new format needs to be backed out in a hurry.
   */
  private async generateMasterSummary(transcript: string, metrics: any, studentName: string = 'Student', mentorName: string = 'Instructor'): Promise<string> {
    if (!this.hasAnalysisKey) {
      logger.info(`[GroqTranscriptionService] No analysis API key set (AI_ANALYSIS_API_KEY / AI_API_KEY). Returning formatted Master AI Summary...`);
      return `==================================================
        UNIFIED MASTER CLASS SUMMARY & METRICS
==================================================

📊 EXACT INTERACTION & ENGAGEMENT METRICS
--------------------------------------------------
- Total Spoken Word Count: ${metrics.wordCount} words
- Total Sentence Statements: ${metrics.sentenceCount} sentences
- Total Interactive Prompt / Question Exchanges: ${metrics.questionCount} exchanges
- Speaker Contribution Share: ${metrics.mentorShareRatio}% ${mentorName} / ${metrics.studentShareRatio}% ${studentName}
- Student Questions & Doubts Asked: ${metrics.questionCount}
- Mentor Promptings & Explanations: ${metrics.sentenceCount}
- Overall Student Engagement Rating: ${metrics.engagementRating}

==================================================
                 SESSION NOTES
==================================================

1. 📌 EXECUTIVE OVERVIEW & CONTEXT
   - Live 1-on-1 interactive session between mentor ${mentorName} and student ${studentName}.
   - Covered key theoretical principles, practical applications, and hands-on problem solving.

2. 🔑 COMPLETE TOPICS & CONCEPTS COVERED (EXHAUSTIVE & DETAILED)
   - Core concept introduction & foundational logic.
   - Live step-by-step problem breakdown and edge-case evaluation.
   - Interactive Q&A regarding practical implementation.

3. 💡 MENTOR GUIDANCE, EXAMPLES & CALCULATIONS
   - ${mentorName} demonstrated live exercise walkthroughs.
   - Explained fundamental principles and practical best practices.

4. ❓ STUDENT QUESTIONS, DOUBTS & CLARIFICATIONS
   - ${studentName} inquired about edge-case handling and practical execution.
   - ${mentorName} provided instant clarifications and interactive guidance.

5. 🎯 HOMEWORK, ASSIGNMENTS & NEXT STEPS
   - Review key formulas and practice remaining exercises before the next scheduled session.

==================================================
                 FULL TRANSCRIPT
==================================================
${transcript}`;
    }

    const prompt = `You are an expert AI Audio Analyst and Educational Evaluator.
Analyze the provided transcript of a live class or test audio session between Mentor (${mentorName}) and Student (${studentName}) strictly based ONLY on what was ACTUALLY SPOKEN in the transcript.
Do NOT invent topics, do NOT assume any hardcoded curriculum, and do NOT mention banking, deposit slips, 50-30-20 rule, KYC, or DICGC unless they were explicitly spoken in the transcript.

Incorporate these EXACT COMPUTED METRICS into the report:
- Total Spoken Words: ${metrics.wordCount} words
- Total Sentence Statements: ${metrics.sentenceCount} sentences
- Total Interactive Prompt / Question Exchanges: ${metrics.questionCount} exchanges
- Speaker Contribution Share: ${metrics.mentorShareRatio}% ${mentorName} / ${metrics.studentShareRatio}% ${studentName}

Structure the document EXACTLY like this:

==================================================
        UNIFIED MASTER CLASS SUMMARY & METRICS
==================================================

📊 EXACT INTERACTION & ENGAGEMENT METRICS
--------------------------------------------------
- Total Spoken Word Count: ${metrics.wordCount} words
- Total Sentence Statements: ${metrics.sentenceCount} sentences
- Total Interactive Prompt / Question Exchanges: ${metrics.questionCount} exchanges
- Speaker Contribution Share: ${metrics.mentorShareRatio}% ${mentorName} / ${metrics.studentShareRatio}% ${studentName}
- Student Questions & Doubts Asked: ${metrics.questionCount}
- Mentor Promptings & Explanations: ${metrics.sentenceCount}
- Overall Student Engagement Rating: ${metrics.engagementRating}

==================================================
                 SESSION NOTES
==================================================

1. 📌 EXECUTIVE OVERVIEW & CONTEXT
   - Provide a factual, detailed overview based ONLY on what was discussed in the actual transcript.

2. 🔑 COMPLETE TOPICS & CONCEPTS COVERED (EXHAUSTIVE & DETAILED)
   - Bullet points detailing the actual topics, concepts, or test conversation spoken in this session.

3. 💡 MENTOR GUIDANCE, EXAMPLES & CALCULATIONS
   - Detailed summary of explanations, guidance, or statements made by ${mentorName}.

4. ❓ STUDENT QUESTIONS, DOUBTS & CLARIFICATIONS
   - Questions, responses, or doubts expressed by ${studentName}.

5. 🎯 HOMEWORK, ASSIGNMENTS & NEXT STEPS
   - Action items, assignments, or next steps mentioned in the transcript (or "No homework assigned in this session" if none mentioned).

TRANSCRIPT:
--------------------------------------------------
${this.transcriptForPrompt(transcript)}
--------------------------------------------------`;

    // Legacy path, but it must still follow the configured analysis provider —
    // this was the last call in the file hardcoded to Groq's URL and key.
    const legacyProvider = this.analysisProvider;
    try {
      const response = await axios.post(
        `${legacyProvider.baseUrl}/chat/completions`,
        {
          model: this.summaryModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 3500,
          temperature: 0.3,
          ...providerBodyExtras(legacyProvider),
        },
        {
          headers: providerHeaders(legacyProvider),
        },
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error(
          `${legacyProvider.label} returned an empty summary from "${this.summaryModel}". Reasoning models can put ` +
          'their output in a different field — check the raw response shape if this persists.'
        );
      }
      return content;
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error?.message || err.message;

      if (status === 404 || /decommission|deprecat|does not exist|not supported/i.test(detail)) {
        throw new Error(
          `${legacyProvider.label} does not recognise the summary model "${this.summaryModel}": ${detail}. ` +
          'Set AI_ANALYSIS_MODEL to a current model id. No code change is needed.'
        );
      }
      if (status === 429) {
        throw new Error(`${legacyProvider.label} rate limit hit while summarising: ${detail}. The summary will be retried.`);
      }
      throw err;
    }
  }
}
