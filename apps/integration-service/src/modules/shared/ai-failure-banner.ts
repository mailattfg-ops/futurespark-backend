/**
 * What the admin sees when the AI pipeline could not produce a summary.
 *
 * The panel this replaces printed three invented bullet points under "SESSION
 * HIGHLIGHTS" — "Live Interactive Discussion", "Hands-on exercises and Q&A" —
 * for a class nobody had analysed, above a one-line status buried in
 * parentheses. It read like a report. It was fiction wrapped around a stack
 * trace, and it is why a module-resolution crash looked for weeks like Groq
 * being slow.
 *
 * This says what failed and what to do, and invents nothing.
 */

export interface AiFailureDetails {
  /** Machine-readable kind from learning-service, when it reached that far. */
  kind?: string;
  /** One-line description of what went wrong. */
  message?: string;
  /** What the operator should actually do. */
  remedy?: string;
  /** The upstream's own words, for the log. */
  detail?: string;
  retryable?: boolean;
}

/**
 * Pull the diagnosis out of whatever came back.
 *
 * learning-service returns `{ message, error: { stage, message, remedy, detail } }`
 * for a diagnosed AI failure. Anything else — a proxy error page, a socket
 * hangup — arrives as a bare string, and is passed through rather than dressed
 * up as something it is not.
 */
/**
 * True when a value is a person's name rather than a UUID or a blank.
 *
 * Meeting rows store ids, not names, so an unresolved lookup leaves a raw UUID
 * in the variable. Printing that is only marginally better than printing the
 * placeholder it replaced — both belong nowhere near a parent-facing panel.
 */
export const hasRealName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());

export const parseAiFailure = (err: any): AiFailureDetails => {
  const raw = err?.message ?? String(err ?? '');

  // learning-service replies are relayed through fetch as text, so the JSON
  // body usually arrives embedded in the thrown message.
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart));
      const inner = body?.error ?? {};
      return {
        kind: inner.stage,
        message: inner.message || body?.message,
        remedy: inner.remedy,
        detail: inner.detail,
        retryable: inner.retryable,
      };
    } catch {
      /* not JSON — fall through */
    }
  }

  return { message: raw };
};

/**
 * The panel body. Deliberately plain text: it is rendered in a <pre> in the
 * recording manager, and the operator needs to be able to copy it into a
 * message to whoever owns the fix.
 */
export const buildAiFailureBanner = (input: {
  fileName: string;
  studentName?: string | null;
  mentorName?: string | null;
  title?: string | null;
  failure: AiFailureDetails;
}): string => {
  const rule = '-'.repeat(72);
  const { failure } = input;

  const lines: string[] = [
    'AI SUMMARY UNAVAILABLE',
    '='.repeat(72),
    '',
    'The recording is safe and plays normally. Only the AI analysis failed.',
    '',
    'WHAT WENT WRONG',
    rule,
    failure.message || 'The transcription service did not return a summary.',
    '',
  ];

  if (failure.remedy) {
    lines.push('HOW TO FIX IT', rule, failure.remedy, '');
  }

  if (failure.retryable) {
    lines.push(
      'This one is worth retrying — the failure was temporary. The transcript is',
      'cached, so a retry does not re-run speech-to-text.',
      ''
    );
  }

  lines.push('DETAILS', rule);
  // Only real, known values. The names are omitted rather than defaulted:
  // this panel used to print "shihad Z" and "mentor 1" — placeholder people —
  // onto a real family's class.
  if (input.title) lines.push(`Class:    ${input.title}`);
  if (input.studentName) lines.push(`Student:  ${input.studentName}`);
  if (input.mentorName) lines.push(`Mentor:   ${input.mentorName}`);
  lines.push(`File:     ${input.fileName}`);
  if (failure.kind) lines.push(`Error:    ${failure.kind}`);
  if (failure.detail && failure.detail !== failure.message) {
    lines.push('', 'Upstream response:', failure.detail.slice(0, 600));
  }

  return lines.join('\n');
};
