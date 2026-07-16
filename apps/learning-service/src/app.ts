import express from 'express';
import cors from 'cors';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { errorHandler } from '@futurespark/middleware';
import { courseRoutes } from './modules/course';

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  logger.info(`[learning-service] ${req.method} ${req.path}`);
  next();
});

// Mount curriculum routes
app.use('/courses', courseRoutes);

app.get('/health', (req, res) => {
  res.status(HTTP_STATUS.OK).json(successResponse({ status: 'UP' }, 'learning-service is healthy'));
});

app.use((req, res) => {
  res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('Route not found'));
});

// Register global error handler
app.use(errorHandler);

export default app;