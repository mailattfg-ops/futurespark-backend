import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';


const PORT = process.env.COMMUNICATION_SERVICE_PORT || 3003;

app.listen(PORT, () => {
  logger.info(`communication-service server listening on port ${PORT}`);
});