/**
 * transcription.types.ts
 *
 * Shared interfaces and small error classes for the transcription pipeline.
 * Extracted from groq-transcription.service.ts to reduce file size and allow
 * re-use by check scripts and tests without importing the full service.
 */

import { type AnalysisEnvelope, type SessionReport } from '@futurespark/constants';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis context & result
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Provider config
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Shown in error messages so an operator knows which vendor refused. */
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcription attempt types
// ─────────────────────────────────────────────────────────────────────────────

/** The two ways audio can reach a provider. */
export type WirePath = 'stt' | 'chat';

/** One rung of the transcription fallback ladder. */
export interface TranscriptionAttempt {
  model: string;
  wire: WirePath;
  /** Shown in the log so an operator can see why this rung was tried. */
  why: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provider answered normally and returned no words.
 *
 * Distinct from a transport or quota failure because the response was a
 * success: it means "this model, on this wire, produced nothing" — which is
 * exactly the case another model or wire may well handle.
 */
export class EmptyTranscriptError extends Error {
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
 * model's ability to do the job.
 */
export const LADDER_WALKABLE_KINDS = new Set([
  'BAD_RESPONSE',
  'MODEL_RETIRED',
  'REQUEST_TOO_LARGE',
  'AUDIO_TOO_LARGE',
  'UNKNOWN',
]);
