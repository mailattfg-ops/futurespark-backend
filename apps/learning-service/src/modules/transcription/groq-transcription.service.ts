import axios from 'axios';
const FormData = require('form-data');
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from '@futurespark/logger';

export class GroqTranscriptionService {
  // Read lazily, not as a captured field. This class is instantiated at module
  // scope by transcription.controller, which can run before dotenv populates
  // process.env — a captured field would freeze an empty key and silently
  // downgrade every job to the offline fallback template.
  private get groqApiKey(): string {
    return process.env.GROQ_API_KEY || '';
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

    const formData = new FormData();
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('file', fs.createReadStream(filePath));

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
   * 3. Groq Llama 3.3 (70B) Master Summary API
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
${transcript.slice(0, 12000)}
--------------------------------------------------`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
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

    return response.data.choices[0].message.content;
  }
}
