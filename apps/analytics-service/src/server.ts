import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';


const PORT = process.env.ANALYTICS_SERVICE_PORT || 3005;

app.listen(PORT, () => {
  logger.info(`analytics-service server listening on port ${PORT}`);
});