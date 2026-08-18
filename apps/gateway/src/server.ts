import './load-env'; // must stay first — populates process.env before ./app loads
import app from './app';
import { logger } from '@futurespark/logger';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Gateway server listening on port ${PORT}`);
});
