export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
};

export const ERROR_CODES = {
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
  ACCESS_DENIED: 'ACCESS_DENIED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

// ── Post-class reflection ─────────────────────────────────────
// Shared because two services need the same list: learning-service serves them
// to the admin editor and student portal, and auth-service snapshots them onto
// the ScheduledClass when a student submits.

/**
 * Prompts every curriculum session starts with. A Session whose
 * `reflectionQuestions` array is empty has never been customised by an admin,
 * and readers substitute these — so no backfill migration is needed and a
 * brand-new session is answerable immediately.
 */
export const DEFAULT_REFLECTION_QUESTIONS: string[] = [
  'What is the most important thing you learned in this session?',
  'Which part did you find most challenging, and why?',
  'How could you use what you learned today outside of class?',
  'What is one question you still have for your mentor?',
  'How confident do you feel about this topic now (1-5), and what would raise it?',
];

/** How many prompts the admin editor renders and the student portal expects. */
export const REFLECTION_QUESTION_COUNT = 5;

/** Effective prompts for a session row — its custom set if any, defaults otherwise. */
export const effectiveReflectionQuestions = (stored: string[] | null | undefined): string[] =>
  stored && stored.length > 0 ? stored : DEFAULT_REFLECTION_QUESTIONS;
