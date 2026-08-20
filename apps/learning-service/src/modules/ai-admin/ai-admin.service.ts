import axios from 'axios';
import { logger } from '@futurespark/logger';
import db from '../../database/datasource';

/**
 * Operator-facing AI administration: the model catalogue, the last-used model
 * memory, and read access to the usage ledger and error log.
 *
 * The catalogue and settings exist so that changing a model is a dropdown in
 * the admin rather than an .env edit and a redeploy — which matters because
 * model choice is the main lever when a transcript mis-attributes speakers or
 * garbles Malayalam.
 */

export interface CatalogueModel {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  /** USD per 1M tokens. */
  inputPrice: number;
  outputPrice: number;
  supportsAudio: boolean;
  description: string;
}

export interface ModelCatalogue {
  /** Models usable for the analysis stage (chat completions). */
  chat: CatalogueModel[];
  /**
   * Models usable for the transcription stage. OpenRouter's /models API does
   * NOT list its /audio/transcriptions models (verified live 2026-08-18: the
   * whisper family transcribes fine but is absent from the catalogue), so the
   * known-good ones are merged in by hand. Audio-capable chat models are also
   * listed — the pipeline sends those the audio through chat completions,
   * which is what enables speaker-labelled transcripts from e.g. Gemini.
   */
  transcription: CatalogueModel[];
  fetchedAt: string;
}

/**
 * Transcription-endpoint models OpenRouter serves but does not list.
 * Prices are per audio-hour (approx, measured 2026-08-18), shown in the
 * description because the token-price fields do not apply.
 */
const HIDDEN_TRANSCRIPTION_MODELS: CatalogueModel[] = [
  {
    id: 'openai/whisper-large-v3-turbo',
    name: 'Whisper Large V3 Turbo',
    provider: 'openai',
    contextLength: 0,
    inputPrice: 0,
    outputPrice: 0,
    supportsAudio: true,
    description: 'Dedicated speech-to-text. ~$0.01/audio-hour. No speaker labels.',
  },
  {
    id: 'openai/whisper-large-v3',
    name: 'Whisper Large V3',
    provider: 'openai',
    contextLength: 0,
    inputPrice: 0,
    outputPrice: 0,
    supportsAudio: true,
    description: 'Dedicated speech-to-text, higher accuracy. ~$0.03/audio-hour. No speaker labels.',
  },
  {
    id: 'openai/whisper-1',
    name: 'Whisper 1',
    provider: 'openai',
    contextLength: 0,
    inputPrice: 0,
    outputPrice: 0,
    supportsAudio: true,
    description: 'Original Whisper API. ~$0.36/audio-hour. No speaker labels.',
  },
];

let catalogueCache: { value: ModelCatalogue; at: number } | null = null;
const CATALOGUE_TTL_MS = 60 * 60 * 1000; // the PRD's ~1 hour

export const getModelCatalogue = async (): Promise<ModelCatalogue> => {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) {
    return catalogueCache.value;
  }

  const response = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 20_000 });
  const raw: any[] = response.data?.data ?? [];

  const mapped: Array<CatalogueModel & { modalities: string[] }> = raw.map((m) => {
    const pricing = m.pricing ?? {};
    const modalities: string[] = m.architecture?.input_modalities ?? [];
    return {
      id: m.id,
      name: m.name ?? m.id,
      provider: String(m.id).split('/')[0] ?? '',
      contextLength: m.context_length ?? m.top_provider?.context_length ?? 0,
      inputPrice: Number(pricing.prompt ?? 0) * 1_000_000,
      outputPrice: Number(pricing.completion ?? 0) * 1_000_000,
      supportsAudio: modalities.includes('audio'),
      description: m.description ?? '',
      modalities,
    };
  });

  // Router pseudo-models and negative-price entries are not pickable targets.
  const pickable = mapped.filter((m) => !m.id.startsWith('openrouter/') && m.inputPrice >= 0);

  const value: ModelCatalogue = {
    chat: pickable
      .map(({ modalities: _m, ...rest }) => rest)
      .sort((a, b) => a.id.localeCompare(b.id)),
    transcription: [
      ...HIDDEN_TRANSCRIPTION_MODELS,
      ...pickable
        .filter((m) => m.supportsAudio)
        .map(({ modalities: _m, ...rest }) => rest)
        .sort((a, b) => a.id.localeCompare(b.id)),
    ],
    fetchedAt: new Date().toISOString(),
  };

  catalogueCache = { value, at: Date.now() };
  return value;
};

/* ── Last-used models ───────────────────────────────────────────────────── */

export interface LastModels {
  transcription?: string;
  analysis?: string;
}

const LAST_MODELS_KEY = 'last_models';

/**
 * Cached for 60s: the transcription pipeline consults this on every run, and a
 * DB read per provider resolution would be pure overhead. An admin's change
 * therefore takes effect within a minute — instant from their own PUT, which
 * clears the cache.
 */
let lastModelsCache: { value: LastModels; at: number } | null = null;

export const getLastModels = async (): Promise<LastModels> => {
  if (lastModelsCache && Date.now() - lastModelsCache.at < 60_000) {
    return lastModelsCache.value;
  }
  try {
    const row = await db.appSetting.findUnique({ where: { key: LAST_MODELS_KEY } });
    const value = (row?.value as LastModels) ?? {};
    lastModelsCache = { value, at: Date.now() };
    return value;
  } catch (err: any) {
    // A settings hiccup must never take the pipeline down — fall back to env.
    logger.warn(`[AiAdmin] Could not read last_models: ${err.message}`);
    return lastModelsCache?.value ?? {};
  }
};

export const saveLastModels = async (patch: LastModels): Promise<LastModels> => {
  const current = await getLastModels();
  const next: LastModels = { ...current };

  // An explicit empty string clears the override back to the .env default.
  for (const field of ['transcription', 'analysis'] as const) {
    if (patch[field] === undefined) continue;
    const trimmed = String(patch[field]).trim();
    if (trimmed.length === 0) delete next[field];
    else next[field] = trimmed;
  }

  await db.appSetting.upsert({
    where: { key: LAST_MODELS_KEY },
    create: { key: LAST_MODELS_KEY, value: next as object },
    update: { value: next as object },
  });
  lastModelsCache = { value: next, at: Date.now() };
  logger.info(
    `[AiAdmin] Model selection saved — transcription: ${next.transcription ?? '(env default)'}, ` +
      `analysis: ${next.analysis ?? '(env default)'}`
  );
  return next;
};

/* ── Usage ledger ───────────────────────────────────────────────────────── */

export interface UsageRecord {
  stage: 'transcription' | 'analysis';
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  costUsd?: number;
  processingMs?: number;
  classId?: string | null;
  recordingId?: string | null;
  fileName?: string | null;
}

/** Best-effort: a ledger failure must never fail the work it measures. */
export const recordAiUsage = async (record: UsageRecord): Promise<void> => {
  try {
    await db.aiUsage.create({
      data: {
        stage: record.stage,
        provider: record.provider ?? null,
        model: record.model ?? null,
        inputTokens: Math.round(record.inputTokens ?? 0),
        outputTokens: Math.round(record.outputTokens ?? 0),
        audioSeconds: record.audioSeconds ?? 0,
        costUsd: record.costUsd ?? 0,
        processingMs: Math.round(record.processingMs ?? 0),
        classId: record.classId ?? null,
        recordingId: record.recordingId ?? null,
        fileName: record.fileName ?? null,
      },
    });
  } catch (err: any) {
    logger.warn(`[AiAdmin] Could not record AI usage: ${err.message}`);
  }
};

export const getUsage = async (limit = 200) => {
  const rows = await db.aiUsage.findMany({ orderBy: { createdAt: 'desc' }, take: limit });

  // Totals over EVERYTHING, not just the page returned. "Classes" counts
  // distinct attributed classIds, plus distinct recordings that never got a
  // class attribution (one recording ≈ one class) — rows written before the
  // pre-run attribution fix have only a recordingId.
  const [bySt, classes, unattributed] = await Promise.all([
    db.aiUsage.groupBy({
      by: ['stage'],
      _sum: { costUsd: true, audioSeconds: true },
      _count: { _all: true },
    }),
    db.aiUsage.findMany({
      where: { classId: { not: null } },
      distinct: ['classId'],
      select: { classId: true },
    }),
    db.aiUsage.findMany({
      where: { classId: null, recordingId: { not: null } },
      distinct: ['recordingId'],
      select: { recordingId: true },
    }),
  ]);

  const stageSum = (stage: string) => bySt.find((s) => s.stage === stage);
  const transcriptionCostUsd = stageSum('transcription')?._sum.costUsd ?? 0;
  const analysisCostUsd = stageSum('analysis')?._sum.costUsd ?? 0;
  const audioSeconds = bySt.reduce((sum, s) => sum + (s._sum.audioSeconds ?? 0), 0);
  const calls = bySt.reduce((sum, s) => sum + s._count._all, 0);
  const classCount = classes.length + unattributed.length;
  const totalCostUsd = transcriptionCostUsd + analysisCostUsd;

  return {
    rows,
    totals: {
      calls,
      classes: classCount,
      audioMinutes: Math.round((audioSeconds / 60) * 10) / 10,
      transcriptionCostUsd,
      analysisCostUsd,
      totalCostUsd,
      avgCostPerClassUsd: classCount > 0 ? totalCostUsd / classCount : 0,
    },
  };
};

/* ── Error log ──────────────────────────────────────────────────────────── */

export interface ErrorRecord {
  stage: 'transcription' | 'analysis';
  kind?: string | null;
  provider?: string | null;
  model?: string | null;
  message: string;
  detail?: string | null;
  remedy?: string | null;
  classId?: string | null;
  recordingId?: string | null;
  retryable?: boolean;
}

/** Best-effort, and never rethrows — logging must not mask the original error. */
export const recordAiError = async (record: ErrorRecord): Promise<void> => {
  try {
    await db.errorLog.create({
      data: {
        stage: record.stage,
        kind: record.kind ?? null,
        provider: record.provider ?? null,
        model: record.model ?? null,
        message: record.message.slice(0, 2000),
        detail: record.detail ? record.detail.slice(0, 10_000) : null,
        remedy: record.remedy ? record.remedy.slice(0, 2000) : null,
        classId: record.classId ?? null,
        recordingId: record.recordingId ?? null,
        retryable: record.retryable ?? false,
      },
    });
  } catch (err: any) {
    logger.warn(`[AiAdmin] Could not record AI error: ${err.message}`);
  }
};

export const getErrors = async (stage?: string, limit = 200, q?: string) => {
  const rows = await db.errorLog.findMany({
    where: {
      ...(stage ? { stage } : {}),
      ...(q
        ? {
            OR: [
              { message: { contains: q, mode: 'insensitive' } },
              { detail: { contains: q, mode: 'insensitive' } },
              { kind: { contains: q, mode: 'insensitive' } },
              { model: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { occurredAt: 'desc' },
    take: limit,
  });
  return { rows };
};

export const clearErrors = async () => {
  const result = await db.errorLog.deleteMany({});
  return { deleted: result.count };
};

/* ── Prompt management ──────────────────────────────────────────────────────
 * Two editable prompt types drive the pipeline (see prompt-defaults.ts).
 * Exactly one ACTIVE version per type; saving a new version activates it and
 * archives the others. Every read the PIPELINE does is failure-proof: no rows,
 * no table, no database — the code default applies and the class still runs.
 * ────────────────────────────────────────────────────────────────────────── */

import { PROMPT_TYPE_DEFS, type PromptTypeDef } from './prompt-defaults';
import { PROMPT_SUITE_VERSION } from '@futurespark/constants';

export { renderPrompt } from './prompt-defaults';

const promptDef = (type: string): PromptTypeDef | undefined =>
  PROMPT_TYPE_DEFS.find((d) => d.type === type);

/** Seed v1 (the code default) for any type with no versions yet. */
const seedPromptType = async (def: PromptTypeDef): Promise<void> => {
  const count = await db.promptVersion.count({ where: { promptType: def.type } });
  if (count > 0) return;
  await db.promptVersion.create({
    data: {
      promptType: def.type,
      version: 1,
      content: def.defaultContent,
      status: 'active',
      changeWhat: 'Initial version',
      changeWhy: 'Seeded from the pipeline default.',
      createdBy: 'system',
    },
  });
  logger.info(`[AiAdmin] Seeded prompt "${def.type}" v1 from the code default.`);
};

export const getPromptOverview = async () => {
  for (const def of PROMPT_TYPE_DEFS) await seedPromptType(def);
  // Self-heals a stale active version if the boot pass was missed.
  await migratePromptSuite();

  const rows = await db.promptVersion.findMany({ orderBy: [{ promptType: 'asc' }, { version: 'desc' }] });
  return {
    types: PROMPT_TYPE_DEFS.map((def) => ({
      type: def.type,
      label: def.label,
      note: def.note,
      variables: def.variables,
      activeVersion: rows.find((r) => r.promptType === def.type && r.status === 'active')?.version ?? null,
      versions: rows.filter((r) => r.promptType === def.type),
    })),
  };
};

export const savePromptVersion = async (
  type: string,
  content: string,
  changeWhat: string,
  changeWhy: string,
  createdBy?: string
) => {
  const def = promptDef(type);
  if (!def) throw new Error(`Unknown prompt type "${type}".`);
  if (!content || content.trim().length < 40) {
    throw new Error('The prompt content is too short to be a working prompt.');
  }
  if (!changeWhat?.trim() || !changeWhy?.trim()) {
    throw new Error('"What changed" and "Why" are both required when saving a new version.');
  }

  const latest = await db.promptVersion.findFirst({
    where: { promptType: type },
    orderBy: { version: 'desc' },
  });

  const [, created] = await db.$transaction([
    db.promptVersion.updateMany({ where: { promptType: type, status: 'active' }, data: { status: 'archived' } }),
    db.promptVersion.create({
      data: {
        promptType: type,
        version: (latest?.version ?? 0) + 1,
        content,
        status: 'active',
        changeWhat: changeWhat.trim(),
        changeWhy: changeWhy.trim(),
        createdBy: createdBy ?? null,
      },
    }),
  ]);

  activePromptCache.delete(type);
  logger.info(`[AiAdmin] Prompt "${type}" v${created.version} saved and activated.`);
  return created;
};

export const activatePromptVersion = async (id: string) => {
  const target = await db.promptVersion.findUnique({ where: { id } });
  if (!target) throw new Error('That prompt version no longer exists.');

  await db.$transaction([
    db.promptVersion.updateMany({
      where: { promptType: target.promptType, status: 'active' },
      data: { status: 'archived' },
    }),
    db.promptVersion.update({ where: { id }, data: { status: 'active' } }),
  ]);

  activePromptCache.delete(target.promptType);
  logger.info(`[AiAdmin] Prompt "${target.promptType}" switched to v${target.version}.`);
  return { ...target, status: 'active' };
};

/** 60s cache — consulted on every pipeline run. */
const activePromptCache = new Map<string, { content: string | null; version: number | null; at: number }>();

/**
 * The active prompt body for a type, or null when the pipeline should use its
 * code default. NEVER throws — prompt management must not stop a class.
 */
export const getActivePrompt = async (
  type: 'transcription' | 'analysis'
): Promise<{ content: string; version: number } | null> => {
  const cached = activePromptCache.get(type);
  if (cached && Date.now() - cached.at < 60_000) {
    return cached.content === null ? null : { content: cached.content, version: cached.version! };
  }
  try {
    const row = await db.promptVersion.findFirst({ where: { promptType: type, status: 'active' } });
    activePromptCache.set(type, { content: row?.content ?? null, version: row?.version ?? null, at: Date.now() });
    return row ? { content: row.content, version: row.version } : null;
  } catch (err: any) {
    logger.warn(`[AiAdmin] Could not read the active "${type}" prompt (${err.message}); using the code default.`);
    return cached && cached.content !== null ? { content: cached.content, version: cached.version! } : null;
  }
};

/* ══════════════════════════════════════════════════════════════════════════
 * PROMPT SUITE MIGRATION
 *
 * The prompts and the code form one contract. v2 asks the model for an
 * EVIDENCE ENVELOPE and derives every number itself; v1 asked for a finished
 * SessionReport with the counts already filled in.
 *
 * `seedPromptType` only ever writes when a type has NO versions, so every
 * environment that has already opened /prompts holds an ACTIVE v1 seeded from
 * the old default — and `buildAnalysisSystemPrompt` layers that stored body in
 * as the editable half. Deploying v2 without this migration therefore ships a
 * prompt that tells the model to return counts AND not to return counts, in
 * one message. It does not fail; it quietly produces worse reports.
 *
 * So: when the code's suite version moves, every prompt type gets a NEW version
 * from the current default, activated. Nothing is deleted — an operator's edits
 * stay in the version history and can be re-applied against the new contract.
 *
 * Runs at boot, not only from the admin page, because the pipeline reads the
 * active prompt whether or not anyone has ever opened /prompts.
 * ═══════════════════════════════════════════════════════════════════════ */

const SUITE_SETTING_KEY = 'prompt_suite_version';

export const migratePromptSuite = async (): Promise<void> => {
  try {
    const setting = await db.appSetting.findUnique({ where: { key: SUITE_SETTING_KEY } });
    const stored = (setting?.value as any)?.version ?? null;

    if (stored === PROMPT_SUITE_VERSION) return;

    for (const def of PROMPT_TYPE_DEFS) {
      const latest = await db.promptVersion.findFirst({
        where: { promptType: def.type },
        orderBy: { version: 'desc' },
      });

      // Nothing stored yet: the ordinary seed path handles it correctly.
      if (!latest) continue;
      // Already byte-identical to the shipped default — activating a copy of
      // it would only add noise to the history.
      if (latest.content === def.defaultContent && latest.status === 'active') continue;

      await db.$transaction([
        db.promptVersion.updateMany({
          where: { promptType: def.type, status: 'active' },
          data: { status: 'archived' },
        }),
        db.promptVersion.create({
          data: {
            promptType: def.type,
            version: latest.version + 1,
            content: def.defaultContent,
            status: 'active',
            changeWhat: `Prompt suite upgraded to v${PROMPT_SUITE_VERSION}`,
            changeWhy:
              'The pipeline now derives every count from cited evidence rather than asking the ' +
              'model for finished numbers. The previous prompt instructed the opposite and would ' +
              'have contradicted the new rules. The older version is kept in the history below — ' +
              're-apply any wording you want on top of this one.',
            createdBy: 'system',
          },
        }),
      ]);

      logger.warn(
        `[AiAdmin] Prompt "${def.type}" was on a pre-v${PROMPT_SUITE_VERSION} body; activated v${latest.version + 1} ` +
          'from the current default. Any custom wording is preserved in the version history.'
      );
    }

    await db.appSetting.upsert({
      where: { key: SUITE_SETTING_KEY },
      create: { key: SUITE_SETTING_KEY, value: { version: PROMPT_SUITE_VERSION } },
      update: { value: { version: PROMPT_SUITE_VERSION } },
    });
    // The pipeline caches the active prompt; clear it so the next class uses
    // the version that was just activated rather than the archived one.
    activePromptCache.clear();
  } catch (err: any) {
    // Never fatal: a class must still be analysable if this fails. The code
    // default is the fallback, and it is the v2 body.
    logger.error(
      `[AiAdmin] Could not migrate the prompt suite to v${PROMPT_SUITE_VERSION}: ${err.message}. ` +
        'The pipeline falls back to the code defaults, which are correct — but /prompts may show a stale active version.'
    );
  }
};
