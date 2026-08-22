import fs from 'fs';
import path from 'path';
import { logger } from '@futurespark/logger';
import {
  GEIST_REGULAR_B64,
  GEIST_SEMIBOLD_B64,
  GEIST_BOLD_B64,
  GEIST_MONO_REGULAR_B64,
  GEIST_MONO_SEMIBOLD_B64,
} from './geist.data';

/**
 * The report's typefaces.
 *
 * Geist and Geist Mono are embedded as base64 so they cannot go missing: tsc
 * does not copy assets into dist, and a font resolved from a path beside the
 * source works in development and then silently falls back in production. A
 * report that quietly stops looking like the approved design is worse than one
 * that fails loudly, because nobody notices until a parent has already read it.
 *
 * Instrument Serif is the one exception. It sets the student's name and the
 * session title — the two lines that give the page its character — and is
 * loaded from a file so it can be dropped in without a rebuild.
 */

export const FONT = {
  /** Running text. */
  body: 'fq-body',
  /** Names, figures, anything carrying weight. */
  bodyBold: 'fq-body-bold',
  /** Weight 700 — the word cloud's large tier, which the design sets heavy. */
  bodyHeavy: 'fq-body-heavy',
  /** Letterspaced labels, captions, axis ticks. */
  mono: 'fq-mono',
  /** Section headings and numbered markers. */
  monoBold: 'fq-mono-bold',
  /** The display serif: student name, session title, wordmark. */
  display: 'fq-display',
} as const;

/** Where a dropped-in Instrument Serif is looked for, in order. */
const serifCandidates = (): string[] => {
  const fromEnv = process.env.REPORT_SERIF_FONT;
  const names = ['InstrumentSerif-Regular.ttf', 'InstrumentSerif.ttf'];
  const roots = [
    // The service's own asset folder — where the other four already live.
    path.resolve(__dirname, '../../../../assets/fonts'),
    path.resolve(__dirname, '../../../../../assets/fonts'),
    path.resolve(process.cwd(), 'assets/fonts'),
    path.resolve(process.cwd(), 'apps/auth-service/assets/fonts'),
  ];
  const out = fromEnv ? [fromEnv] : [];
  for (const root of roots) for (const n of names) out.push(path.join(root, n));
  return out;
};

let serifWarned = false;

const loadSerif = (): Buffer | null => {
  for (const candidate of serifCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) return fs.readFileSync(candidate);
    } catch {
      /* unreadable — try the next one */
    }
  }
  if (!serifWarned) {
    serifWarned = true;
    logger.warn(
      '[ReportPDF] Instrument Serif was not found, so the display headings fall back to Times-Roman. ' +
        `Drop InstrumentSerif-Regular.ttf into ${path.resolve(__dirname, '../../../../assets/fonts')} ` +
        'or point REPORT_SERIF_FONT at it.'
    );
  }
  return null;
};

export interface ReportFonts {
  /** False when Instrument Serif is missing and Times-Roman is standing in. */
  displayIsSerif: boolean;
}

/**
 * Register every face on the document. Call once, before drawing.
 *
 * Times-Roman is the fallback rather than Helvetica because the design's
 * headings are a serif; falling back to a sans would change the page's voice
 * far more than falling back to a plainer serif does.
 */
export const registerReportFonts = (doc: PDFKit.PDFDocument): ReportFonts => {
  doc.registerFont(FONT.body, Buffer.from(GEIST_REGULAR_B64, 'base64'));
  doc.registerFont(FONT.bodyBold, Buffer.from(GEIST_SEMIBOLD_B64, 'base64'));
  doc.registerFont(FONT.bodyHeavy, Buffer.from(GEIST_BOLD_B64, 'base64'));
  doc.registerFont(FONT.mono, Buffer.from(GEIST_MONO_REGULAR_B64, 'base64'));
  doc.registerFont(FONT.monoBold, Buffer.from(GEIST_MONO_SEMIBOLD_B64, 'base64'));

  const serif = loadSerif();
  if (serif) {
    doc.registerFont(FONT.display, serif);
    return { displayIsSerif: true };
  }

  doc.registerFont(FONT.display, 'Times-Roman');
  return { displayIsSerif: false };
};
