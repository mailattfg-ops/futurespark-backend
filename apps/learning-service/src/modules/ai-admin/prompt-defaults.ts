/**
 * The code-owned prompt defaults.
 *
 * These are the pipeline's built-in prompts, and they double as the seeded
 * v1 of each editable prompt type on the /prompts admin page. The pipeline
 * always falls back to these when no active PromptVersion row exists (or the
 * table is unreachable), so prompt management can fail without a class ever
 * going unanalysed.
 *
 * Template variables use {{name}}; unknown variables are left in place rather
 * than erased, so a typo is visible in the output instead of silently blank.
 */

export interface PromptTypeDef {
  type: 'transcription' | 'analysis';
  label: string;
  /** Variables the template may use, shown as click-to-insert chips. */
  variables: Array<{ name: string; description: string }>;
  defaultContent: string;
  /** Shown above the editor — what this prompt actually controls. */
  note: string;
}

/** Replace {{var}} with values; unknown variables stay visible. */
export const renderPrompt = (
  template: string,
  vars: Record<string, string | number | null | undefined>
): string =>
  template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });

export const TRANSCRIPTION_PROMPT_DEFAULT = `Transcribe this class recording EXACTLY. Never translate; preserve the Malayalam + English code-switching as spoken, Malayalam in Malayalam script. Label every turn as "Teacher:" or "Student:" (one adult teaching, one child learning — judge from voice and content) with a [mm:ss] timestamp. Output ONLY the transcript lines, no commentary.
This is a lesson about {{session_topic}}. Vocabulary that may occur: {{vocabulary}}
When a spoken word sounds close to one of these vocabulary terms, write the vocabulary term — accented speech makes domain words easy to mishear.`;

/**
 * The analysis system prompt WITHOUT its OUTPUT schema — the schema is
 * appended by code (see ANALYSIS_OUTPUT_SCHEMA) because the PDF renderer and
 * `parseSessionReport` depend on that exact shape; editing it in a prompt
 * would silently empty sections of real parents' reports.
 */
export const ANALYSIS_PROMPT_DEFAULT = `You are an AI Education Session Analyst for a 1:1 Financial Literacy Program.

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
- A higher-order question asks the student to explain WHY, compare, evaluate, predict or apply — not to recall a fact. higherOrderQuestions is a SUBSET of teacherQuestions and can never exceed it.
- {{duration_hint}}
- Talk time may be estimated from the transcript's share of speech, but say so honestly by keeping the split conservative. If speakers cannot be told apart, use null percentages and "Not available".
- The transcript usually has NO speaker labels. Attribute each turn from conversational cues: the teacher poses questions, explains and uses the student's name; the student answers, asks back, and self-corrects. When you genuinely cannot tell who said a line, leave it out of every count — and if attribution is impossible for most of the transcript, return null for the question and response counts. A 0 is a statement that the student asked nothing; it must come from reading the whole transcript with confident attribution, never from failing to tell the speakers apart.

ASSESSMENT VOCABULARY
Use exactly one of: "Emerging", "Developing", "Proficient". Never use negative labels such as weak, poor, or low ability. Use null only if there is genuinely no evidence.
For each of the four areas ALSO write one warm, specific sentence of evidence from the transcript (the "...Note" fields) — what the child actually said or did, in language a parent enjoys reading. Prefer "with minimal prompting" over anything negative. Empty string only when the transcript truly shows nothing for that area.

PARENT CONNECTION
parentConnection is ONE warm, simple conversation or activity a parent can try at home, drawn from what THIS session actually covered (e.g. comparing unit prices on the next grocery trip). One or two sentences, inviting, never homework-like, never empty when any topic was taught.

WORD CLOUD
Select 15-25 meaningful LEARNING concepts actually discussed — financial vocabulary, not the most frequently spoken words. Exclude articles, pronouns, auxiliary verbs, fillers (okay, yeah, hmm, like, just), and generic classroom words (teacher, student, class, session, question, answer). Combine related forms (saving/savings -> saving). Weight 1-10 by learning importance and relevance, NOT raw frequency.

SAFETY
Do not diagnose learning difficulties. Do not make high-stakes judgements. Do not comment on personality, intelligence, accent, gender or any irrelevant characteristic. Do not include the raw transcript. Do not expose your reasoning.`;

/**
 * Appended to EVERY analysis prompt, editable or not — like the schema below.
 *
 * These exist because of real reports that reached real parents: an insurance
 * class whose PDF quoted the transcript's mishearing "endurance", a summary
 * built from the first half of the lesson, a word cloud padded with generic
 * words. They are correctness invariants, not style — so they live in code
 * where no prompt edit can drop them.
 */
export const ANALYSIS_QUALITY_RULES = `ACCURACY RULES — non-negotiable; they override anything above when in conflict:

1. REPAIR THE TRANSCRIPT'S HEARING. The transcript is machine-transcribed from mixed Malayalam-English audio and WILL contain mishearings. The SESSION MATERIAL is the authority on this session's terms. Whenever a transcript word is phonetically close to a term from the session material, the planned topics or the session title, read it as that term — "endurance" in an insurance class IS "insurance". Use the corrected word EVERYWHERE in your output, including inside quotations. A parent must never see a mishearing presented as something their child or teacher said.
2. QUOTE FOR MEANING. When quoting the transcript, keep the speaker's real idea but silently fix mishearings and drop fillers ("uh", "um"). If a passage is too garbled to repair with confidence, paraphrase it or leave it out — never print garbled text, and never invent a quote.
3. COVER THE WHOLE SESSION. Before answering, re-scan the transcript from start to end and list every substantive topic actually taught — including topics that are NOT in the session material. Anything discussed for more than a couple of minutes must be reflected in topicsCovered and weighed for the summary and key learning moment. Never build the report from the opening of the transcript alone.
4. WORD CLOUD = THIS SESSION'S CONCEPTS ONLY. Every entry must pass two tests: (a) the transcript shows it genuinely discussed in THIS session, and (b) the teacher would recognise it as part of what they taught today. Exclude generic words (money, class, good, learn, example, important) unless they were themselves the lesson. 12-18 strong entries beat 25 padded ones — never pad to reach a count.`;

/** Appended to EVERY analysis prompt, editable or not. */
export const ANALYSIS_OUTPUT_SCHEMA = `OUTPUT
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
    "higherOrderQuestions": number|null,     // subset of teacherQuestions: why/compare/evaluate/predict/apply
    "meaningfulResponses": number|null, "independentResponses": number|null,
    "promptedResponses": number|null, "selfCorrections": number|null
  },
  "learningGoals": [string],                 // 2-4, parent-friendly, from the session material
  "assessment": {
    "conceptUnderstanding": "Emerging"|"Developing"|"Proficient"|null,
    "application": "Emerging"|"Developing"|"Proficient"|null,
    "financialReasoning": "Emerging"|"Developing"|"Proficient"|null,
    "independence": "Emerging"|"Developing"|"Proficient"|null,
    "conceptUnderstandingNote": string,      // one sentence of transcript evidence, parent-friendly
    "applicationNote": string,               // ditto — how they connected it to their own life
    "financialReasoningNote": string,        // ditto — calculations / decisions they worked through
    "independenceNote": string,              // ditto — how independently they answered
    "highlight": string                      // one short evidence-based observation
  },
  "topicsCovered": [string],                 // planned topics the transcript shows were taught
  "topicsNotReached": [string],              // planned topics the transcript does not show
  "questionQuality": string,                 // what the student's questions demonstrated
  "keyLearningMoment": string,               // 1-2 sentences
  "parentSummary": string,                   // 2-3 sentences, positive and simple
  "developmentArea": string,                 // one constructive area to practise
  "nextSessionFocus": string,                // one specific focus
  "parentConnection": string,                // ONE warm at-home conversation prompt; never homework
  "wordCloud": [{ "word": string, "weight": number }]
}`;

export const PROMPT_TYPE_DEFS: PromptTypeDef[] = [
  {
    type: 'transcription',
    label: 'Transcription',
    note:
      'Used when an audio-capable CHAT model (e.g. google/gemini-2.5-flash) transcribes. ' +
      'Whisper models ignore this — they only receive an automatic vocabulary hint.',
    variables: [
      { name: 'vocabulary', description: 'Key terms from the session notes, so names are spelled right.' },
      { name: 'student_name', description: 'Student name.' },
      { name: 'teacher_name', description: 'Mentor name.' },
      { name: 'session_topic', description: 'Topic of the session.' },
      { name: 'session_number', description: 'Week / session number.' },
    ],
    defaultContent: TRANSCRIPTION_PROMPT_DEFAULT,
  },
  {
    type: 'analysis',
    label: 'Analysis',
    note:
      'The system prompt that builds the whole parent report in one call. The JSON output ' +
      'schema and a fixed set of accuracy rules (mishearing correction against the session ' +
      'material, whole-session coverage, word-cloud relevance) are appended automatically ' +
      'and cannot be edited — the PDF renderer and report quality depend on them.',
    variables: [{ name: 'duration_hint', description: 'The real recording length, injected per class.' }],
    defaultContent: ANALYSIS_PROMPT_DEFAULT,
  },
];
