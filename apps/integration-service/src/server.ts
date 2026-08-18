import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';


const PORT = process.env.INTEGRATION_SERVICE_PORT || 3006;

app.listen(PORT, () => {
  logger.info(`integration-service server listening on port ${PORT}`);
});