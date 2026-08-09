import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';

const PORT = process.env.LEARNING_SERVICE_PORT || 3002;

app.listen(PORT, () => {
  logger.info(`learning-service server listening on port ${PORT}`);
  logger.info(`[learning-service] GROQ_API_KEY ${process.env.GROQ_API_KEY ? 'loaded' : 'MISSING'}`);
});
