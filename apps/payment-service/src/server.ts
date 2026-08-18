import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';


const PORT = process.env.PAYMENT_SERVICE_PORT || 3004;

app.listen(PORT, () => {
  logger.info(`payment-service server listening on port ${PORT}`);
});