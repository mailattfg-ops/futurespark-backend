import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';

const PORT = process.env.LEARNING_SERVICE_PORT || 3002;

app.listen(PORT, () => {
  logger.info(`learning-service server listening on port ${PORT}`);

  /* AI_PROVIDER_BANNER
   * Which vendor each stage will actually call, printed at boot.
   *
   * The symptom of a missed .env edit is not an error — it is the analysis
   * quietly staying on Groq and taking seventeen minutes instead of seconds.
   * One line here answers "did my config take effect?" without a test run. */
  const stage = (base?: string, key?: string, model?: string, fallbackModel?: string) => {
    const url = (base || 'https://api.groq.com/openai/v1').replace(/[/]+$/, '');
    const vendor = url.includes('openrouter.ai') ? 'OpenRouter'
                 : url.includes('groq.com') ? 'Groq'
                 : url.includes('googleapis') ? 'Gemini' : url;
    return `${vendor} · ${model || fallbackModel} · key ${key ? 'set' : 'MISSING'}`;
  };

  logger.info(
    '[learning-service] AI analysis      -> ' +
      stage(
        process.env.AI_ANALYSIS_BASE_URL || process.env.AI_BASE_URL,
        process.env.AI_ANALYSIS_API_KEY || process.env.AI_API_KEY || process.env.GROQ_API_KEY,
        process.env.AI_ANALYSIS_MODEL || process.env.GROQ_SUMMARY_MODEL,
        'openai/gpt-oss-120b'
      )
  );
  logger.info(
    '[learning-service] AI transcription -> ' +
      stage(
        process.env.AI_TRANSCRIPTION_BASE_URL || process.env.AI_BASE_URL,
        process.env.AI_TRANSCRIPTION_API_KEY || process.env.AI_API_KEY || process.env.GROQ_API_KEY,
        process.env.AI_TRANSCRIPTION_MODEL || process.env.GROQ_TRANSCRIPTION_MODEL,
        'whisper-large-v3-turbo'
      )
  );

  const budget = Number(process.env.GROQ_MAX_REQUEST_TOKENS || 0);
  if (budget > 0) {
    logger.warn(
      `[learning-service] GROQ_MAX_REQUEST_TOKENS=${budget} — the analysis will be split into ` +
        'paced passes. Set it to 0 unless the analysis provider meters tokens per minute.'
    );
  }
});
