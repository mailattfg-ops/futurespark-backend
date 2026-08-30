/**
 * Parse model output that is *nearly* JSON.
 *
 * Under json_object mode a model still occasionally drops a comma between two
 * array elements, leaves a trailing comma, wraps the object in a code fence,
 * or is cut off by its token limit mid-array. Each of those used to escape as
 * a raw SyntaxError ("Expected ',' or ']' after array element … position
 * 6988") and abandon the whole recording — after a transcription that had
 * already succeeded and been paid for.
 *
 * Strictly a syntax repair: nothing here changes what the model said, only
 * whether the punctuation around it parses. If the text cannot be made to
 * parse, `null` is returned and the caller decides whether to ask again.
 */

const stripFence = (s: string): string => {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : s).trim();
};

const outerObject = (s: string): string => {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
};

/** Punctuation slips: trailing commas, and missing commas between elements. */
const fixCommas = (s: string): string =>
  s
    // "…},\n  }" and "[1, 2,]" — a trailing comma before a closer.
    .replace(/,(\s*[}\]])/g, '$1')
    // A raw newline between a closer and the next element is structural —
    // JSON strings cannot contain raw newlines — so a comma is missing there.
    .replace(/([}\]"])(\s*\n\s*)([{\["])/g, '$1,$2$3');

/**
 * Close what an early cut-off left open. Walks the text tracking strings and
 * nesting, cuts back to the last complete element, and appends the closers.
 */
const closeTruncated = (s: string): string | null => {
  const cutPoints: number[] = [];
  for (let i = s.length - 1; i >= 0 && cutPoints.length < 200; i--) {
    if (s[i] === '}' || s[i] === ']') cutPoints.push(i + 1);
  }
  for (const cut of cutPoints) {
    const prefix = s.slice(0, cut);
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (const ch of prefix) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inString) continue;
    const candidate = fixCommas(prefix.replace(/,\s*$/, '') + stack.reverse().join(''));
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* try an earlier cut */
    }
  }
  return null;
};

export interface RepairedJson {
  value: any;
  /** What it took: 'none' means the text was valid as given. */
  repair: 'none' | 'fence' | 'commas' | 'truncation';
}

export const parseRepairedJson = (content: string): RepairedJson | null => {
  const attempts: Array<[RepairedJson['repair'], string]> = [
    ['none', content],
    ['fence', outerObject(stripFence(content))],
    ['commas', fixCommas(outerObject(stripFence(content)))],
  ];
  for (const [repair, text] of attempts) {
    try {
      return { value: JSON.parse(text), repair };
    } catch {
      /* next */
    }
  }
  const closed = closeTruncated(outerObject(stripFence(content)));
  if (closed) {
    try {
      return { value: JSON.parse(closed), repair: 'truncation' };
    } catch {
      /* fall through */
    }
  }
  return null;
};
