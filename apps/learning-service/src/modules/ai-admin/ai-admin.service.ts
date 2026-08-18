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

  // Totals over EVERYTHING, not just the page returned.
  const [bySt, classes] = await Promise.all([
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
  ]);

  const stageSum = (stage: string) => bySt.find((s) => s.stage === stage);
  const transcriptionCostUsd = stageSum('transcription')?._sum.costUsd ?? 0;
  const analysisCostUsd = stageSum('analysis')?._sum.costUsd ?? 0;
  const audioSeconds = bySt.reduce((sum, s) => sum + (s._sum.audioSeconds ?? 0), 0);
  const calls = bySt.reduce((sum, s) => sum + s._count._all, 0);
  const classCount = classes.length;
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

export const getErrors = async (stage?: string, limit = 200) => {
  const rows = await db.errorLog.findMany({
    where: stage ? { stage } : undefined,
    orderBy: { occurredAt: 'desc' },
    take: limit,
  });
  return { rows };
};

export const clearErrors = async () => {
  const result = await db.errorLog.deleteMany({});
  return { deleted: result.count };
};
