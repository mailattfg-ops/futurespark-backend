import { Router, type Request, type Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import {
  activatePromptVersion,
  clearErrors,
  getErrors,
  getLastModels,
  getModelCatalogue,
  getPromptOverview,
  getProviderBalance,
  getUsage,
  saveLastModels,
  savePromptVersion,
} from './ai-admin.service';

/**
 * /ai/* — operator endpoints behind the gateway's authentication. Reads are
 * open to any authenticated staff role; writes (model selection, clearing the
 * error log) are ADMIN-only, judged from the gateway-injected x-user-role
 * header the same way the schedule endpoints do it.
 */

const router = Router();

const isAdmin = (req: Request): boolean =>
  String(req.headers['x-user-role'] ?? '').toUpperCase() === 'ADMIN';

router.get('/models', async (_req: Request, res: Response) => {
  try {
    const catalogue = await getModelCatalogue();
    res.status(HTTP_STATUS.OK).json(successResponse(catalogue, 'Model catalogue loaded.'));
  } catch (err: any) {
    logger.error(`[AiAdmin] Catalogue fetch failed: ${err.message}`);
    res
      .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
      .json(errorResponse('Could not reach the OpenRouter model catalogue. Try again in a minute.'));
  }
});

router.get('/settings/models', async (_req: Request, res: Response) => {
  try {
    const stored = await getLastModels();
    res.status(HTTP_STATUS.OK).json(
      successResponse(
        {
          stored,
          // What each stage will ACTUALLY use right now, so the picker can show
          // the effective model even when nothing has been chosen yet.
          effective: {
            transcription:
              stored.transcription ||
              process.env.AI_TRANSCRIPTION_MODEL ||
              process.env.GROQ_TRANSCRIPTION_MODEL ||
              'whisper-large-v3-turbo',
            analysis:
              stored.analysis ||
              process.env.AI_ANALYSIS_MODEL ||
              process.env.GROQ_SUMMARY_MODEL ||
              'openai/gpt-oss-120b',
          },
          envDefaults: {
            transcription: process.env.AI_TRANSCRIPTION_MODEL || null,
            analysis: process.env.AI_ANALYSIS_MODEL || null,
          },
        },
        'Model settings loaded.'
      )
    );
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

router.put('/settings/models', async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res
      .status(HTTP_STATUS.FORBIDDEN)
      .json(errorResponse('Only an admin can change the AI models.'));
  }
  try {
    const { transcription, analysis } = req.body ?? {};
    if (transcription === undefined && analysis === undefined) {
      return res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(errorResponse('Provide "transcription" and/or "analysis" (empty string resets to the .env default).'));
    }
    const stored = await saveLastModels({ transcription, analysis });
    res
      .status(HTTP_STATUS.OK)
      .json(successResponse({ stored }, 'Model selection saved — it applies from the next run.'));
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

router.get('/usage', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const data = await getUsage(limit);
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'AI usage loaded.'));
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

/**
 * What is left to spend at the AI provider.
 *
 * Separate from /usage on purpose: usage is our own ledger of what we spent,
 * this is the provider's own figure for what remains. A provider running out
 * stops every transcription and analysis at once, so it is worth seeing before
 * it happens rather than as a wave of failed classes.
 */
router.get('/balance', async (_req: Request, res: Response) => {
  try {
    const balance = await getProviderBalance();
    res.status(HTTP_STATUS.OK).json(successResponse(balance, 'Provider balance loaded.'));
  } catch (err: any) {
    // Never a 500: the costs page must render even when the provider is down.
    res.status(HTTP_STATUS.OK).json(
      successResponse(
        {
          provider: 'unknown',
          remainingUsd: null,
          grantedUsd: null,
          usedUsd: null,
          unlimited: false,
          error: err.message,
          checkedAt: new Date().toISOString(),
        },
        'Provider balance unavailable.'
      )
    );
  }
});

router.get('/errors', async (req: Request, res: Response) => {
  try {
    const stage = typeof req.query.stage === 'string' && req.query.stage ? req.query.stage : undefined;
    const q = typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined;
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const data = await getErrors(stage, limit, q);
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'AI errors loaded.'));
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

/* ── Prompt management ──────────────────────────────────────────────────── */

router.get('/prompts', async (_req: Request, res: Response) => {
  try {
    const data = await getPromptOverview();
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'Prompts loaded.'));
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

router.post('/prompts/:type/versions', async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin can edit the prompts.'));
  }
  try {
    const { content, changeWhat, changeWhy } = req.body ?? {};
    const created = await savePromptVersion(
      req.params.type,
      String(content ?? ''),
      String(changeWhat ?? ''),
      String(changeWhy ?? ''),
      String(req.headers['x-user-id'] ?? '') || undefined
    );
    res.status(HTTP_STATUS.OK).json(
      successResponse({ version: created }, `Saved and activated v${created.version} — it applies from the next run.`)
    );
  } catch (err: any) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(err.message));
  }
});

router.post('/prompts/versions/:id/activate', async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(HTTP_STATUS.FORBIDDEN).json(errorResponse('Only an admin can switch prompt versions.'));
  }
  try {
    const activated = await activatePromptVersion(req.params.id);
    res.status(HTTP_STATUS.OK).json(
      successResponse({ version: activated }, `v${activated.version} is now active — it applies from the next run.`)
    );
  } catch (err: any) {
    res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse(err.message));
  }
});

router.delete('/errors', async (req: Request, res: Response) => {
  if (!isAdmin(req)) {
    return res
      .status(HTTP_STATUS.FORBIDDEN)
      .json(errorResponse('Only an admin can clear the error log.'));
  }
  try {
    const data = await clearErrors();
    res.status(HTTP_STATUS.OK).json(successResponse(data, 'Error log cleared.'));
  } catch (err: any) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message));
  }
});

export const aiAdminRoutes = router;
