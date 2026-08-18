import axios from 'axios';
const FormData = require('form-data');
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from '@futurespark/logger';
import { parseSessionReport, sessionReportToText, type SessionReport } from '@futurespark/constants';
import { describeGroqFailure, estimateTokens, GroqError } from './groq-errors';

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
/** Groq's own recommended successor to llama-3.3-70b-versatile. */
const DEFAULT_SUMMARY_MODEL = 'openai/gpt-oss-120b';

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

  constructor(private readonly limit: number) {}

  async waitFor(tokens: number): Promise<void> {
    for (;;) {
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
 * Total a count across passes.
 *
 * Returns null when NO pass reported the field — zero is a claim about the
 * child ("asked no questions") and must never come from a failure to measure.
 */
const sumCounts = (notes: any[], key: string): number | null => {
  let total = 0;
  let seen = false;
  for (const note of notes) {
    const value = Number(note?.[key]);
    if (Number.isFinite(value) && value >= 0) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
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

export class GroqTranscriptionService {
  // Read lazily, not as a captured field. This class is instantiated at module
  // scope by transcription.controller, which can run before dotenv populates
  // process.env — a captured field would freeze an empty key and silently
  // downgrade every job to the offline fallback template.
  private get groqApiKey(): string {
    return process.env.GROQ_API_KEY || '';
  }

  private get transcriptionModel(): string {
    return process.env.GROQ_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL;
  }

  private get summaryModel(): string {
    return process.env.GROQ_SUMMARY_MODEL || DEFAULT_SUMMARY_MODEL;
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

    let localFilePath = audioFilePath;
    const isUrl = audioFilePath.startsWith('http://') || audioFilePath.startsWith('https://');

    // Both the STT and summary stages degrade to canned placeholder text when the
    // key is absent. Surface that to callers so placeholder output is never cached
    // or persisted as if it were a real AI summary.
    const usedFallback = !this.groqApiKey || this.groqApiKey.length < 5;
    if (usedFallback) {
      logger.error(
        `[GroqTranscriptionService] GROQ_API_KEY missing — returning PLACEHOLDER transcript/summary, not real AI output.`
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

      let transcript = '';
      let classSummary = '';
      let metrics: any;
      let report: SessionReport | null = null;

      // 1. Transcribe with Groq Whisper. Errors already carry their diagnosis,
      //    so they are re-thrown untouched rather than wrapped in a second,
      //    vaguer message that hides it.
      transcript = await this.transcribeWithGroqWhisper(fileToTranscribe);

      metrics = this.calculateTranscriptMetrics(transcript, studentName, mentorName);

      // 2. Analyse the recording against the session slides.
      const built = await this.generateSessionReport(transcript, studentName, mentorName, context);
      report = built;
      classSummary = sessionReportToText(built);

      // Clean up temporary compressed audio if created
      if (fileToTranscribe !== audioFilePath && fs.existsSync(fileToTranscribe)) {
        try { fs.unlinkSync(fileToTranscribe); } catch (_) { }
      }

      return { transcript, classSummary, metrics, report, usedFallback };
    } catch (err: any) {
      logger.error(`[GroqTranscriptionService] Fatal error in audio processing: ${err.message}`);
      throw err;
    }
  }

  /**
   * Compress audio/video file locally using ffmpeg if size > 20MB or is video format
   */
  private compressAudioIfNeeded(filePath: string): string {
    const stats = fs.statSync(filePath);
    const fileSizeMb = stats.size / (1024 * 1024);
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

    if (fileSizeMb < 20.0 && ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'].includes(ext)) {
      return filePath;
    }

    const tempOutput = filePath + '.compressed.mp3';
    if (fs.existsSync(tempOutput) && fs.statSync(tempOutput).size > 1000000) {
      logger.info(`[GroqTranscriptionService] [✓] Found existing compressed audio: ${tempOutput} - Reusing!`);
      return tempOutput;
    }

    logger.info(`[GroqTranscriptionService] [+] File size: ${fileSizeMb.toFixed(2)}MB (${ext}). Extracting & compressing audio to MP3...`);

    let ffmpegPath = 'ffmpeg';
    try {
      ffmpegPath = require('@ffmpeg-installer/ffmpeg').path || require('ffmpeg-static') || 'ffmpeg';
    } catch (e) {
      try {
        ffmpegPath = require('ffmpeg-static') || 'ffmpeg';
      } catch (_) { }
    }

    const { execFileSync } = require('child_process');
    try {
      execFileSync(ffmpegPath, ['-y', '-i', filePath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', tempOutput], {
        stdio: 'pipe',
      });
      const newStats = fs.statSync(tempOutput);
      const newSizeMb = newStats.size / (1024 * 1024);
      logger.info(`[GroqTranscriptionService] [✓] Compressed audio: ${tempOutput} (${newSizeMb.toFixed(2)}MB) - Ready for Groq Whisper!`);
      return tempOutput;
    } catch (err: any) {
      logger.warn(`[GroqTranscriptionService] ⚠️ Compression failed: ${err.message}. Attempting fallback...`);
      return filePath;
    }
  }

  /**
   * 1. Groq Whisper STT API
   */
  private async transcribeWithGroqWhisper(filePath: string): Promise<string> {
    if (!this.groqApiKey || this.groqApiKey.length < 5) {
      logger.info(`[GroqTranscriptionService] GROQ_API_KEY not set in environment. Generating dynamic AI session transcript...`);
      return `[00:00:05] Instructor: Welcome to today's live interactive session. Today we are exploring key concepts and hands-on exercises for this program.
[00:00:22] Student: Thank you! I'm ready to get started. I had a quick question regarding the initial concepts we discussed in the pre-session reading.
[00:00:45] Instructor: Great question! Let's break that down step-by-step. First, we need to examine how the fundamental principles operate in practice.
[00:01:30] Student: Ah, I see now. So when we apply that logic, does it change the outcome for edge cases?
[00:02:15] Instructor: Exactly right. That is why we structure our solution carefully. Let's work through a live demonstration together.
[00:03:40] Student: That makes complete sense. I appreciate the clear explanation and live walkthrough.
[00:04:50] Instructor: Excellent progress today! For your assignment before our next session, review the key formulas and practice the remaining exercises. See you next class!`;
    }

    const sizeBytes = fs.statSync(filePath).size;

    // Small enough to send whole — the common case for a 60-90 minute class.
    if (sizeBytes <= this.maxUploadBytes) {
      return this.uploadForTranscription(filePath);
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
      `[GroqTranscriptionService] Audio is ${sizeMb}MB, over the ${(this.maxUploadBytes / (1024 * 1024)).toFixed(0)}MB ` +
        `per-request limit. Splitting into ${this.chunkSeconds / 60}-minute chunks and transcribing in sequence.`
    );

    const chunks = this.splitAudio(filePath);
    if (chunks.length === 0) {
      throw new Error(
        `Audio is ${sizeMb}MB, above Groq's ${(this.maxUploadBytes / (1024 * 1024)).toFixed(0)}MB request limit, ` +
          'and it could not be split (ffmpeg failed). Raise GROQ_MAX_UPLOAD_MB if you are on the paid ' +
          'dev tier (100MB), or check that ffmpeg is available.'
      );
    }

    const parts: string[] = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        logger.info(`[GroqTranscriptionService] Transcribing chunk ${i + 1}/${chunks.length}...`);
        // The tail of the previous chunk is passed as `prompt` so Whisper keeps
        // spelling and terminology consistent across a cut — otherwise a name
        // established in chunk 1 can come back spelled differently in chunk 2.
        const carryOver = parts.length > 0 ? parts[parts.length - 1].slice(-200) : undefined;
        parts.push(await this.uploadForTranscription(chunks[i], carryOver));
      }
    } finally {
      for (const chunk of chunks) {
        try { fs.unlinkSync(chunk); } catch (_) { /* best effort */ }
      }
    }

    return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
  }

  /** One file, one request to Groq. */
  private async uploadForTranscription(filePath: string, promptContext?: string): Promise<string> {
    const formData = new FormData();
    formData.append('model', this.transcriptionModel);
    formData.append('file', fs.createReadStream(filePath));
    if (promptContext) formData.append('prompt', promptContext);

    try {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        formData,
        {
          headers: {
            Authorization: `Bearer ${this.groqApiKey}`,
            ...formData.getHeaders(),
          },
          maxBodyLength: Infinity,
        },
      );

      return response.data.text;
    } catch (err: any) {
      // Every Groq failure gets diagnosed once, here, so the message that
      // reaches an operator names the limit that was hit and how to raise it —
      // rather than "Request failed with status code 413".
      const audioMb = fs.existsSync(filePath) ? fs.statSync(filePath).size / (1024 * 1024) : undefined;
      throw new GroqError(
        describeGroqFailure(err, 'transcription', { model: this.transcriptionModel, audioMb })
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
    const pattern = path.join(dir, `${base}.chunk-%03d${ext}`);

    // Clear any chunks left behind by a previous crashed run, so a stale piece
    // from an earlier class cannot be picked up and transcribed into this one.
    for (const stale of fs.readdirSync(dir)) {
      if (stale.startsWith(`${base}.chunk-`)) {
        try { fs.unlinkSync(path.join(dir, stale)); } catch (_) { /* best effort */ }
      }
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
      .filter((name) => name.startsWith(`${base}.chunk-`) && name.endsWith(ext))
      .sort()
      .map((name) => path.join(dir, name));
  }

  /**
   * 2. Native Transcript Metrics Calculation
   */
  private calculateTranscriptMetrics(text: string, studentName: string = 'Student', mentorName: string = 'Instructor') {
    const words = text.split(/\s+/).filter(Boolean).length;
    const sentences = text.split(/[.!?]+/).filter(Boolean).length;
    const questions = (text.match(/\?/g) || []).length;

    let mentorWordCount = 0;
    let studentWordCount = 0;

    const lines = text.split('\n');
    const studentRegex = new RegExp(`${studentName}`, 'i');
    const mentorRegex = new RegExp(`${mentorName}|mentor|instructor|teacher`, 'i');

    let currentSpeaker: 'mentor' | 'student' = 'mentor';

    for (const line of lines) {
      if (studentRegex.test(line)) {
        currentSpeaker = 'student';
      } else if (mentorRegex.test(line)) {
        currentSpeaker = 'mentor';
      }

      const lineWords = line.split(/\s+/).filter(Boolean).length;
      if (currentSpeaker === 'mentor') {
        mentorWordCount += lineWords;
      } else {
        studentWordCount += lineWords;
      }
    }

    const totalSpeakerWords = mentorWordCount + studentWordCount;
    let mentorShareRatio = 68;
    let studentShareRatio = 32;

    if (totalSpeakerWords > 0) {
      mentorShareRatio = Math.round((mentorWordCount / totalSpeakerWords) * 100);
      studentShareRatio = 100 - mentorShareRatio;
    }

    return {
      wordCount: words,
      sentenceCount: Math.max(sentences, 1),
      questionCount: questions,
      mentorShareRatio,
      studentShareRatio,
      engagementRating: studentShareRatio >= 25 ? 'HIGH' : studentShareRatio >= 15 ? 'MEDIUM' : 'MODERATE',
    };
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
   * The ceiling existed for llama-3.3-70b's budget. gpt-oss-120b has a 131,072
   * token context — about 500,000 characters — so 120,000 (a ~2.5 hour class)
   * is comfortable, and the tail is what gets kept when a class runs longer:
   * the end of a lesson carries the homework and the next steps, which is the
   * part a parent acts on.
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
   * Analyse the recording against the session slides and return a structured
   * Student Session Report.
   *
   * ── Two inputs, two different jobs ──
   * The SLIDES say what was PLANNED. The RECORDING says what HAPPENED. Keeping
   * that distinction sharp in the prompt is the whole game: given curriculum
   * text, a language model will happily describe the lesson as designed and
   * hand a parent a report about concepts their child never reached. So the
   * slides are scoped to interpretation — naming, spelling, and deciding which
   * planned stops were actually covered — and every claim about the CHILD must
   * come from the audio.
   *
   * ── Why JSON and not the formatted report ──
   * The specification asks for tables, fixed status vocabulary and a visual word
   * cloud. Models cannot draw, and prose parsed back into tables is exactly the
   * fragility this pipeline already suffered from. The model returns data; the
   * PDF renderer owns the layout, so every session's report is identical by
   * construction.
   */
  private async generateSessionReport(
    transcript: string,
    studentName: string,
    mentorName: string,
    context: ClassAnalysisContext
  ): Promise<SessionReport> {
    const slides = (context.slideContent ?? '').trim();
    const slideLimit = readNumberEnv('GROQ_SLIDE_CONTENT_CHARS', 40_000);
    const slideBlock = slides
      ? slides.slice(0, slideLimit)
      : '(No session material was provided. Derive the learning goals and topics from the recording alone, and keep them conservative.)';

    const plannedTopics = (context.plannedTopics ?? []).filter(Boolean);

    const durationHint = context.audioSeconds
      ? `The recording is ${Math.round(context.audioSeconds)} seconds long (${Math.floor(context.audioSeconds / 60)}m ${Math.round(context.audioSeconds % 60)}s). Use this as the total session duration.`
      : 'The exact recording length is unknown. Set duration to "Not available" unless the audio makes it clear.';

    const systemPrompt = this.reportSystemPrompt(durationHint);

    const userPrompt = `STUDENT: ${studentName}
TEACHER: ${mentorName}
SESSION: ${context.sessionTitle ?? 'Not available'}${context.sessionOrder ? ` (Session ${context.sessionOrder}${context.sessionTotal ? ` of ${context.sessionTotal}` : ''})` : ''}
DATE: ${context.classDate ?? 'Not available'}
SCHEDULED START: ${context.startTime ?? 'Not available'}
SCHEDULED END: ${context.endTime ?? 'Not available'}
${plannedTopics.length > 0 ? `PLANNED TOPICS: ${plannedTopics.join('; ')}` : ''}

===== INPUT 1 — SESSION MATERIAL (what was PLANNED) =====
${slideBlock}

===== INPUT 2 — SESSION TRANSCRIPT (what actually HAPPENED) =====
${this.transcriptForPrompt(transcript)}
===== END OF TRANSCRIPT =====

Return the JSON object now.`;

    const send = async (system: string, user: string) => {
      const requestTokens = estimateTokens(system + user) + 6000; // + the reply budget
      logger.info(
        `[GroqTranscriptionService] Sending analysis to ${this.summaryModel} — about ` +
          `${requestTokens.toLocaleString()} tokens.`
      );

      try {
        const response = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: this.summaryModel,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 6000,
            temperature: 0.2,
          },
          {
            headers: {
              Authorization: `Bearer ${this.groqApiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: readNumberEnv('GROQ_SUMMARY_TIMEOUT_MS', 180_000),
          },
        );

        const content = response.data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new GroqError(
            describeGroqFailure(new Error(`"${this.summaryModel}" returned an empty message.`), 'analysis', {
              model: this.summaryModel,
            })
          );
        }
        return content;
      } catch (err: any) {
        if (err instanceof GroqError) throw err;
        throw new GroqError(describeGroqFailure(err, 'analysis', { model: this.summaryModel, requestTokens }));
      }
    };

    return this.runAnalysis(
      transcript, slideBlock, studentName, mentorName, context, systemPrompt, userPrompt, send
    );
  }

  /** The Student Session Report instructions, shared by every analysis path. */
  private reportSystemPrompt(durationHint = 'Use the transcript to judge the session length.'): string {
    return `You are an AI Education Session Analyst for a 1:1 Financial Literacy Program.

You receive two inputs:
  INPUT 1 — SESSION MATERIAL: the standardised slides, key terms, activities, quiz and speaker notes for this session. This is what was PLANNED.
  INPUT 2 — SESSION TRANSCRIPT: the actual 1:1 conversation between teacher and student. This is what HAPPENED.

HOW TO USE EACH INPUT — this distinction is critical:
- Use the SESSION MATERIAL to understand what the student was expected to learn, to name and spell concepts the way the curriculum does, and to judge which planned topics were reached.
- Use the TRANSCRIPT, and ONLY the transcript, for every statement about the student: what they understood, how they participated, how they applied concepts, how independently they answered, what they asked.
- NEVER describe a concept as covered because it appears in the material. If the transcript does not show it being taught, it belongs in topicsNotReached.
- NEVER invent a number, a quotation or an observation. If something cannot be established from the transcript, use null for counts and "Not available" for text.

PRIMARY OBJECTIVE
Evaluate the STUDENT's learning journey. This is not a teacher performance review; never criticise the teacher.

COUNTING RULES
- A meaningful response explains an idea, gives reasoning, provides an example, makes a financial decision, compares choices, asks a meaningful question, reflects, or self-corrects.
- "yes", "no", "okay", "hmm" and similar are NOT meaningful unless they demonstrate understanding.
- An independent response is given without the teacher supplying or leading to the answer; a prompted response needed help.
- ${durationHint}
- Talk time may be estimated from the transcript's share of speech, but say so honestly by keeping the split conservative. If speakers cannot be told apart, use null percentages and "Not available".

ASSESSMENT VOCABULARY
Use exactly one of: "Emerging", "Developing", "Proficient". Never use negative labels such as weak, poor, or low ability. Use null only if there is genuinely no evidence.

WORD CLOUD
Select 15-25 meaningful LEARNING concepts actually discussed — financial vocabulary, not the most frequently spoken words. Exclude articles, pronouns, auxiliary verbs, fillers (okay, yeah, hmm, like, just), and generic classroom words (teacher, student, class, session, question, answer). Combine related forms (saving/savings -> saving). Weight 1-10 by learning importance and relevance, NOT raw frequency.

SAFETY
Do not diagnose learning difficulties. Do not make high-stakes judgements. Do not comment on personality, intelligence, accent, gender or any irrelevant characteristic. Do not include the raw transcript. Do not expose your reasoning.

OUTPUT
Return ONLY a JSON object matching this schema exactly — no markdown, no commentary:

{
  "student": string,
  "teacher": string,
  "sessionTopic": string,
  "weekNumber": number|null,
  "weekTotal": number|null,
  "date": string,
  "timing": { "startTime": string, "endTime": string, "duration": string },
  "talkTime": { "teacher": string, "student": string, "teacherPercent": number|null, "studentPercent": number|null },
  "interactions": {
    "teacherQuestions": number|null, "studentQuestions": number|null,
    "meaningfulResponses": number|null, "independentResponses": number|null,
    "promptedResponses": number|null, "selfCorrections": number|null
  },
  "learningGoals": [string],                 // 2-4, parent-friendly, from the session material
  "assessment": {
    "conceptUnderstanding": "Emerging"|"Developing"|"Proficient"|null,
    "application": "Emerging"|"Developing"|"Proficient"|null,
    "financialReasoning": "Emerging"|"Developing"|"Proficient"|null,
    "independence": "Emerging"|"Developing"|"Proficient"|null,
    "highlight": string                      // one short evidence-based observation
  },
  "topicsCovered": [string],                 // planned topics the transcript shows were taught
  "topicsNotReached": [string],              // planned topics the transcript does not show
  "questionQuality": string,                 // what the student's questions demonstrated
  "keyLearningMoment": string,               // 1-2 sentences
  "parentSummary": string,                   // 2-3 sentences, positive and simple
  "developmentArea": string,                 // one constructive area to practise
  "nextSessionFocus": string,                // one specific focus
  "wordCloud": [{ "word": string, "weight": number }]
}`;
  }

  /**
   * Run the analysis and turn the reply into a report.
   *
   * Split out from prompt-building so the single-request path and the
   * multi-pass path share exactly one parser, one validator and one set of
   * fallbacks — the two drifting apart is how a report ends up rendering
   * differently depending on which Groq plan produced it.
   */
  private async runAnalysis(
    transcript: string,
    slideBlock: string,
    studentName: string,
    mentorName: string,
    context: ClassAnalysisContext,
    systemPrompt: string,
    userPrompt: string,
    send: (system: string, user: string) => Promise<string>
  ): Promise<SessionReport> {
    const slides = (context.slideContent ?? '').trim();

    /* ── Does the whole class fit in one request? ─────────────────────────
     * On the Groq FREE tier, `openai/gpt-oss-120b` allows 8,000 tokens per
     * MINUTE. That is a spend ceiling, not a context ceiling — the model holds
     * 131,072 tokens — so a 90-minute class is refused outright with 413 even
     * though it would fit comfortably in the window.
     *
     * When a budget is configured and the class exceeds it, the analysis runs
     * in passes instead of failing: see `analyseInPasses`. The whole lesson is
     * still read, just a slice at a time.
     * ─────────────────────────────────────────────────────────────────── */
    const budget = readNumberEnv('GROQ_MAX_REQUEST_TOKENS', 0);
    const singleShotTokens = estimateTokens(systemPrompt + userPrompt) + 6000;

    if (budget > 0 && singleShotTokens > budget) {
      logger.info(
        `[GroqTranscriptionService] The class needs about ${singleShotTokens.toLocaleString()} tokens, over the ` +
          `${budget.toLocaleString()}-token per-request budget. Running the analysis in passes so the whole ` +
          'lesson is still read.'
      );
      return this.analyseInPasses(transcript, slideBlock, studentName, mentorName, context, budget, send);
    }

    let content: string;
    let partial = false;

    try {
      content = await send(systemPrompt, userPrompt);
    } catch (err: any) {
      /* ── Too big to send: shrink once, and say so ─────────────────────────
       * 413 here is a TOKENS-PER-MINUTE ceiling, not a context limit. The model
       * holds 131k tokens; Groq's free tier only lets 8k through per minute, so
       * a 90-minute class is refused outright.
       *
       * Retrying smaller is the difference between a partial report and none at
       * all — but a report silently built from a fifth of the lesson would tell
       * a parent their child never covered things they did. So the retry marks
       * the report as partial, and that marking travels all the way to the PDF.
       * ─────────────────────────────────────────────────────────────────── */
      // Reaching here with a budget set means the token ESTIMATE was optimistic
      // — the pre-check above would otherwise have routed this to the passes.
      // Truncating once is the safety net under that estimate.
      const kind = err instanceof GroqError ? err.failure.kind : null;

      if (kind !== 'REQUEST_TOO_LARGE' || budget <= 0) {
        if (kind === 'REQUEST_TOO_LARGE') {
          logger.error(
            '[GroqTranscriptionService] The class is too large for this Groq plan and ' +
              'GROQ_MAX_REQUEST_TOKENS is not set, so no truncated retry was attempted. ' +
              'Set it to force a partial report, or upgrade the Groq plan for a complete one.'
          );
        }
        throw err;
      }

      // Leave room for the system prompt, the slides and the 6k reply.
      const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(slideBlock) + 6000;
      const transcriptTokens = Math.max(1500, budget - fixedTokens);
      const transcriptChars = Math.floor(transcriptTokens * 3.6);

      logger.warn(
        `[GroqTranscriptionService] Retrying the analysis with the transcript cut to ~` +
          `${transcriptChars.toLocaleString()} characters to fit a ${budget.toLocaleString()}-token budget. ` +
          'The report will be marked PARTIAL.'
      );

      const shortTranscript =
        transcript.length <= transcriptChars
          ? transcript
          : `${transcript.slice(0, Math.floor(transcriptChars * 0.5))}\n\n[... middle omitted — this plan could not accept the whole class ...]\n\n${transcript.slice(-Math.floor(transcriptChars * 0.5))}`;

      const shortUser = userPrompt.replace(this.transcriptForPrompt(transcript), shortTranscript);
      content = await send(systemPrompt, shortUser);
      partial = true;
    }

    let raw: any;
    try {
      raw = JSON.parse(content);
    } catch {
      // Belt and braces: some models still wrap JSON in a fenced block even
      // under json_object mode.
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new GroqError(
          describeGroqFailure(new Error('Groq did not return parseable JSON.'), 'analysis', {
            model: this.summaryModel,
          })
        );
      }
      raw = JSON.parse(match[0]);
    }

    const report = parseSessionReport(raw, {
      student: studentName,
      teacher: mentorName,
      sessionTopic: context.sessionTitle ?? undefined,
      weekNumber: context.sessionOrder ?? null,
      weekTotal: context.sessionTotal ?? null,
      date: context.classDate ?? undefined,
    });

    if (partial) {
      // Stated on the report itself, not just in a log line nobody reads.
      report.parentSummary =
        `[Based on part of the recording only — the full class could not be analysed on the current ` +
        `AI plan.] ${report.parentSummary}`.trim();
    }

    logger.info(
      `[GroqTranscriptionService] Session report built — ${report.learningGoals.length} goal(s), ` +
        `${report.topicsCovered.length} topic(s) covered, ${report.topicsNotReached.length} not reached, ` +
        `${report.wordCloud.length} word-cloud concept(s)` +
        `${slides ? '' : ' (NO session material was available)'}${partial ? ' [PARTIAL]' : ''}.`
    );

    return report;
  }

  /**
   * Analyse a class that is too large for one request, in passes.
   *
   * ── Why this exists ──
   * Groq's free tier caps `gpt-oss-120b` at 8,000 tokens per MINUTE. A
   * 90-minute class is roughly 40,000 tokens, so it cannot be sent at all —
   * and truncating it means telling a parent about a fifth of the lesson while
   * silently dropping the rest, including the homework set at the end.
   *
   * Map-reduce instead. Each pass reads one slice of the transcript and returns
   * compact notes; a final pass turns all the notes into the report. Every
   * request stays under the budget, and the WHOLE lesson is read.
   *
   * The cost is wall-clock: the passes are paced to respect tokens-per-minute,
   * so a 90-minute class takes six or seven minutes to analyse. That is free in
   * practice — this runs in the background 90 minutes after the class ended,
   * and nobody is waiting on it.
   *
   * This is a workaround for a plan limit, not an improvement. A single pass
   * sees the whole conversation at once and can reason across it; passes cannot.
   * The paid tier is better analysis, not just faster.
   */
  private async analyseInPasses(
    transcript: string,
    slideBlock: string,
    studentName: string,
    mentorName: string,
    context: ClassAnalysisContext,
    budget: number,
    send: (system: string, user: string) => Promise<string>
  ): Promise<SessionReport> {
    // Slides are condensed to their vocabulary for the pass stage — the full
    // deck alone would eat the entire budget before a word of transcript fits.
    const slideOutline = condenseSlides(slideBlock);

    const perPassOverhead = estimateTokens(slideOutline) + 1200 /* instructions */ + 900 /* reply */;
    const transcriptTokensPerPass = Math.max(1200, budget - perPassOverhead);
    const charsPerPass = Math.floor(transcriptTokensPerPass * 3.6);

    const slices: string[] = [];
    for (let i = 0; i < transcript.length; i += charsPerPass) {
      slices.push(transcript.slice(i, i + charsPerPass));
    }

    const maxPasses = readNumberEnv('GROQ_MAX_ANALYSIS_PASSES', 12);
    if (slices.length > maxPasses) {
      // Keep the beginning and the end: the opening establishes the topic, the
      // close carries the homework and next steps.
      const keepHead = Math.ceil(maxPasses / 2);
      const keepTail = maxPasses - keepHead;
      logger.warn(
        `[GroqTranscriptionService] ${slices.length} passes needed but the ceiling is ${maxPasses}. ` +
          'Reading the opening and the closing; the middle will be skipped.'
      );
      slices.splice(keepHead, slices.length - maxPasses);
      void keepTail;
    }

    logger.info(
      `[GroqTranscriptionService] Reading the class in ${slices.length} pass(es) of ~${charsPerPass.toLocaleString()} characters.`
    );

    const passSystem = `You are analysing ONE SLICE of a 1:1 financial literacy lesson transcript.
You will be given the vocabulary of the session's material for reference, then a slice of the conversation.

Extract ONLY what this slice actually shows. Do not speculate about parts you cannot see, and do not
describe anything as taught unless this slice shows it being taught.

Return ONLY JSON:
{
  "topicsTaught": [string],        // concepts actually explained or worked through here
  "studentMoments": [string],      // things the STUDENT said or did that show understanding, reasoning or confusion
  "studentQuestions": [string],    // questions the student asked, quoted briefly
  "teacherQuestionCount": number,  // questions the teacher asked in this slice
  "meaningfulResponses": number,   // student responses that explained, reasoned, compared or decided
  "independentResponses": number,  // answered without the teacher supplying the answer
  "promptedResponses": number,     // needed help to get there
  "concepts": [string],            // financial vocabulary genuinely discussed here
  "homework": [string]             // any task, assignment or next step set in this slice
}`;

    const notes: any[] = [];
    const pacer = new TpmPacer(budget);

    for (let i = 0; i < slices.length; i++) {
      const user = `SESSION VOCABULARY (for naming only — never treat as taught):
${slideOutline}

TRANSCRIPT SLICE ${i + 1} OF ${slices.length}:
${slices[i]}

Return the JSON now.`;

      await pacer.waitFor(estimateTokens(passSystem + user) + 900);

      try {
        const raw = await send(passSystem, user);
        notes.push(JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw));
        logger.info(`[GroqTranscriptionService] Pass ${i + 1}/${slices.length} complete.`);
      } catch (err: any) {
        // One bad slice must not cost the whole report — the other passes still
        // describe most of the lesson.
        logger.error(`[GroqTranscriptionService] Pass ${i + 1} failed: ${err.message}. Continuing without it.`);
      }
    }

    if (notes.length === 0) {
      throw new GroqError(
        describeGroqFailure(new Error('Every analysis pass failed.'), 'analysis', { model: this.summaryModel })
      );
    }

    // ── Reduce: notes -> the report ──
    const merged = {
      topicsTaught: dedupeStrings(notes.flatMap((n) => n?.topicsTaught ?? [])),
      studentMoments: dedupeStrings(notes.flatMap((n) => n?.studentMoments ?? [])).slice(0, 25),
      studentQuestions: dedupeStrings(notes.flatMap((n) => n?.studentQuestions ?? [])).slice(0, 20),
      concepts: dedupeStrings(notes.flatMap((n) => n?.concepts ?? [])).slice(0, 40),
      homework: dedupeStrings(notes.flatMap((n) => n?.homework ?? [])).slice(0, 10),
      // Summed rather than re-estimated: these are counts of real events, and
      // each pass counted the events it could actually see.
      teacherQuestions: sumCounts(notes, 'teacherQuestionCount'),
      meaningfulResponses: sumCounts(notes, 'meaningfulResponses'),
      independentResponses: sumCounts(notes, 'independentResponses'),
      promptedResponses: sumCounts(notes, 'promptedResponses'),
    };

    const reduceUser = `STUDENT: ${studentName}
TEACHER: ${mentorName}
SESSION: ${context.sessionTitle ?? 'Not available'}${context.sessionOrder ? ` (Session ${context.sessionOrder}${context.sessionTotal ? ` of ${context.sessionTotal}` : ''})` : ''}
DATE: ${context.classDate ?? 'Not available'}
SCHEDULED START: ${context.startTime ?? 'Not available'}
SCHEDULED END: ${context.endTime ?? 'Not available'}

===== SESSION MATERIAL (what was PLANNED) =====
${slideOutline}

===== OBSERVATIONS FROM THE WHOLE RECORDING =====
These were extracted pass by pass from the complete class. Counts are totals across the lesson.
${JSON.stringify(merged, null, 1)}

Build the Student Session Report from these observations. Anything in the session material that does
NOT appear in topicsTaught belongs in topicsNotReached. Talk-time percentages could not be measured
across passes — set them to null and both talk strings to "Not available".

Return the JSON object now.`;

    await pacer.waitFor(estimateTokens(reduceUser) + 6000);
    const finalRaw = await send(this.reportSystemPrompt(), reduceUser);

    let raw: any;
    try {
      raw = JSON.parse(finalRaw);
    } catch {
      const match = finalRaw.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new GroqError(
          describeGroqFailure(new Error('Groq did not return parseable JSON.'), 'analysis', {
            model: this.summaryModel,
          })
        );
      }
      raw = JSON.parse(match[0]);
    }

    const report = parseSessionReport(raw, {
      student: studentName,
      teacher: mentorName,
      sessionTopic: context.sessionTitle ?? undefined,
      weekNumber: context.sessionOrder ?? null,
      weekTotal: context.sessionTotal ?? null,
      date: context.classDate ?? undefined,
    });

    logger.info(
      `[GroqTranscriptionService] Multi-pass report built from ${notes.length} pass(es) — ` +
        `${report.topicsCovered.length} topic(s) covered, ${report.wordCloud.length} concept(s).`
    );

    return report;
  }

  /**
   * The previous free-text summary. Unused by the pipeline since the structured
   * report replaced it, and kept only because `GROQ_LEGACY_SUMMARY=true` is a
   * one-line escape hatch if the new format needs to be backed out in a hurry.
   */
  private async generateMasterSummary(transcript: string, metrics: any, studentName: string = 'Student', mentorName: string = 'Instructor'): Promise<string> {
    if (!this.groqApiKey || this.groqApiKey.length < 5) {
      logger.info(`[GroqTranscriptionService] GROQ_API_KEY not set in environment. Returning formatted Master AI Summary...`);
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

    try {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: this.summaryModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 3500,
          temperature: 0.3,
        },
        {
          headers: {
            Authorization: `Bearer ${this.groqApiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error(
          `Groq returned an empty summary from "${this.summaryModel}". Reasoning models can put their ` +
            'output in a different field — check the raw response shape if this persists.'
        );
      }
      return content;
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error?.message || err.message;

      if (status === 404 || /decommission|deprecat|does not exist|not supported/i.test(detail)) {
        throw new Error(
          `Groq does not recognise the summary model "${this.summaryModel}": ${detail}. Groq retires ` +
            'models on a few weeks\' notice — check https://console.groq.com/docs/deprecations and set ' +
            'GROQ_SUMMARY_MODEL to the replacement. No code change is needed.'
        );
      }
      if (status === 429) {
        throw new Error(`Groq rate limit hit while summarising: ${detail}. The summary will be retried.`);
      }
      throw err;
    }
  }
}
