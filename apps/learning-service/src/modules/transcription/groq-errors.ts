/**
 * Turning Groq failures into something a human can act on.
 *
 * Every one of these has a different fix, and until now they all surfaced as
 * the same line in a parent-facing panel: "AI Transcription pending". A lapsed
 * API key, a retired model, a class too long for the free tier and a genuine
 * outage are four different jobs for four different people, and the operator
 * could not tell them apart without reading server logs.
 *
 * Each failure therefore carries: what happened, WHY, and what to do about it.
 */

export type GroqFailureKind =
  | 'NO_API_KEY'
  | 'AUTH_FAILED'
  | 'MODEL_RETIRED'
  | 'REQUEST_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'AUDIO_TOO_LARGE'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface GroqFailure {
  kind: GroqFailureKind;
  /** One line, safe to show an operator in the admin panel. */
  summary: string;
  /** What to actually do. Empty when there is nothing useful to say. */
  remedy: string;
  /** Groq's own message, kept verbatim for the logs. */
  detail: string;
  httpStatus?: number;
  /** True when the same request could succeed later without any change. */
  retryable: boolean;
}

/** Which API call failed — the same status means different things per endpoint. */
export type GroqStage = 'transcription' | 'analysis';

const MODEL_RETIRED_PATTERN = /decommission|deprecat|does not exist|no longer|not supported|unknown model/i;

export const describeGroqFailure = (
  err: any,
  stage: GroqStage,
  context: { model?: string; requestTokens?: number; audioMb?: number } = {}
): GroqFailure => {
  const httpStatus: number | undefined = err?.response?.status;
  const detail: string =
    err?.response?.data?.error?.message ||
    err?.response?.data?.error ||
    err?.message ||
    String(err);

  const model = context.model ?? 'the configured model';

  if (err?.code === 'ECONNABORTED' || /timeout/i.test(detail)) {
    return {
      kind: 'TIMEOUT',
      summary: `Groq did not respond in time during ${stage}.`,
      remedy:
        'A long class can take a while to analyse. Raise GROQ_SUMMARY_TIMEOUT_MS, or retry — the ' +
        'transcript is already cached so a retry does not re-run speech-to-text.',
      detail,
      httpStatus,
      retryable: true,
    };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      kind: 'AUTH_FAILED',
      summary: 'Groq rejected the API key.',
      remedy:
        'GROQ_API_KEY is missing, revoked or wrong. Generate a new key at console.groq.com > API Keys ' +
        'and redeploy. ALL transcription and summaries are down until this is fixed.',
      detail,
      httpStatus,
      retryable: false,
    };
  }

  if (httpStatus === 404 || MODEL_RETIRED_PATTERN.test(detail)) {
    return {
      kind: 'MODEL_RETIRED',
      summary: `Groq does not recognise the model "${model}".`,
      remedy:
        'Groq retires models on a few weeks\' notice. Check https://console.groq.com/docs/deprecations ' +
        `and set ${stage === 'analysis' ? 'GROQ_SUMMARY_MODEL' : 'GROQ_TRANSCRIPTION_MODEL'} to the ` +
        'replacement. No code change is needed.',
      detail,
      httpStatus,
      retryable: false,
    };
  }

  if (httpStatus === 413) {
    if (stage === 'transcription') {
      return {
        kind: 'AUDIO_TOO_LARGE',
        summary: `The audio file${context.audioMb ? ` (${context.audioMb.toFixed(1)} MB)` : ''} is larger than Groq will accept in one request.`,
        remedy:
          'The free tier caps a request at 25 MB, the developer tier at 100 MB. Lower ' +
          'GROQ_MAX_UPLOAD_MB so the audio is split into more chunks.',
        detail,
        httpStatus,
        retryable: false,
      };
    }
    return {
      kind: 'REQUEST_TOO_LARGE',
      summary:
        `The class is too long to analyse in one request` +
        `${context.requestTokens ? ` (about ${context.requestTokens.toLocaleString()} tokens)` : ''}.`,
      remedy:
        `This is a TOKENS-PER-MINUTE limit, not a context limit — "${model}" can hold 131,072 tokens, ` +
        'but the Groq FREE tier only allows 8,000 per minute, so a 90-minute class cannot be sent at ' +
        'all. Upgrade to the developer tier (pay-as-you-go; a class costs a few cents), or set ' +
        'GROQ_MAX_REQUEST_TOKENS to force truncation — the report is then built from part of the ' +
        'lesson and is marked as partial.',
      detail,
      httpStatus,
      retryable: false,
    };
  }

  if (httpStatus === 429) {
    return {
      kind: 'RATE_LIMITED',
      summary: `Groq rate limit reached during ${stage}.`,
      remedy:
        stage === 'transcription'
          ? 'The free tier allows 7,200 audio-seconds per HOUR and 28,800 per DAY — about five ' +
            '90-minute classes a day, or two finishing in the same hour. Upgrade to the developer ' +
            'tier ($0.04 per hour of audio) or spread the classes out.'
          : 'The free tier allows 8,000 tokens per minute for the analysis model. Wait a minute and ' +
            'retry, or upgrade to the developer tier.',
      detail,
      httpStatus,
      retryable: true,
    };
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return {
      kind: 'SERVICE_UNAVAILABLE',
      summary: `Groq returned a server error (${httpStatus}) during ${stage}.`,
      remedy: 'This is Groq\'s side, not yours. Retry in a few minutes; check https://groqstatus.com.',
      detail,
      httpStatus,
      retryable: true,
    };
  }

  if (!httpStatus && /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up/i.test(detail)) {
    return {
      kind: 'NETWORK_ERROR',
      summary: 'Could not reach Groq.',
      remedy: 'The server has no route to api.groq.com. Check outbound networking and DNS.',
      detail,
      httpStatus,
      retryable: true,
    };
  }

  return {
    kind: 'UNKNOWN',
    summary: `Groq ${stage} failed${httpStatus ? ` with HTTP ${httpStatus}` : ''}.`,
    remedy: 'Check the learning-service log for the full response.',
    detail,
    httpStatus,
    retryable: false,
  };
};

/**
 * An Error that carries its diagnosis, so the message reaching the operator is
 * the actionable one rather than "Request failed with status code 413".
 */
export class GroqError extends Error {
  readonly failure: GroqFailure;

  constructor(failure: GroqFailure) {
    super(failure.remedy ? `${failure.summary} ${failure.remedy}` : failure.summary);
    this.name = 'GroqError';
    this.failure = failure;
  }
}

/** Serialisable form, for the HTTP response body. */
export const failureToPayload = (failure: GroqFailure) => ({
  stage: failure.kind,
  message: failure.summary,
  remedy: failure.remedy,
  detail: failure.detail,
  retryable: failure.retryable,
});

/**
 * Rough token count. Deliberately pessimistic (3.6 chars/token rather than the
 * usual 4) — overestimating costs a slightly smaller prompt, underestimating
 * costs a rejected request after the expensive transcription has already run.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);
