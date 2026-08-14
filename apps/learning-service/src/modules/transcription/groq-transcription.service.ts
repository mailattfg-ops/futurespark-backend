import axios from 'axios';
const FormData = require('form-data');
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from '@futurespark/logger';

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
  async processClassAudio(audioFilePath: string, studentName: string = 'Student', mentorName: string = 'Instructor') {
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

      try {
        // 1. Transcribe with Groq Whisper Large v3
        transcript = await this.transcribeWithGroqWhisper(fileToTranscribe);
      } catch (err: any) {
        logger.error(`[GroqTranscriptionService] Groq Whisper API call failed: ${err.message}`);
        throw new Error(`Groq Whisper STT API failed: ${err.message}`);
      }

      metrics = this.calculateTranscriptMetrics(transcript, studentName, mentorName);

      try {
        // 3. Generate Master AI Summary with Llama 3.3 (70B)
        classSummary = await this.generateMasterSummary(transcript, metrics, studentName, mentorName);
      } catch (err: any) {
        logger.error(`[GroqTranscriptionService] Groq Llama 3.3 Summary API failed: ${err.message}`);
        throw new Error(`Groq Llama 3.3 Summary API failed: ${err.message}`);
      }

      // Clean up temporary compressed audio if created
      if (fileToTranscribe !== audioFilePath && fs.existsSync(fileToTranscribe)) {
        try { fs.unlinkSync(fileToTranscribe); } catch (_) { }
      }

      return { transcript, classSummary, metrics, usedFallback };
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
      // Groq's raw errors do not say which limit was hit, and the two that
      // actually bite here have completely different fixes.
      const status = err?.response?.status;
      const detail = err?.response?.data?.error?.message || err.message;

      if (status === 413) {
        throw new Error(
          `Groq rejected the audio as too large: ${detail}. The free tier caps a request at 25MB ` +
            '(dev tier 100MB). Lower GROQ_MAX_UPLOAD_MB so the file is split into more pieces.'
        );
      }
      if (status === 429) {
        throw new Error(
          `Groq rate limit hit: ${detail}. The free tier allows 7,200 audio-seconds per HOUR and ` +
            '28,800 per DAY — about five 90-minute classes a day. Upgrade to the pay-as-you-go dev ' +
            'tier (whisper-large-v3-turbo is $0.04 per hour of audio) or spread the classes out.'
        );
      }
      if (status === 404 || /decommission|deprecat|does not exist/i.test(detail)) {
        throw new Error(
          `Groq does not recognise the transcription model "${this.transcriptionModel}": ${detail}. ` +
            'It has probably been retired — check https://console.groq.com/docs/deprecations and set ' +
            'GROQ_TRANSCRIPTION_MODEL to the replacement.'
        );
      }
      throw err;
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
   * 3. Groq master summary (model set by GROQ_SUMMARY_MODEL)
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
