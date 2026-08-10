import { Request, Response } from 'express';
import { logger } from '@futurespark/logger';
import { successResponse, errorResponse } from '@futurespark/response';
import { HTTP_STATUS } from '@futurespark/constants';
import { S3Storage } from '@futurespark/storage';
import * as fs from 'fs';
import * as path from 'path';

const UPLOADS_BASE = path.resolve(__dirname, '../../../../');
const UPLOADS_DIR = path.join(UPLOADS_BASE, 'uploads/sessions');

// Ensure local uploads directories exist for fallback
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (e: any) {
  logger.warn(`Failed to create local uploads directory: ${e.message}`);
}

export class StorageController {
  static async getPresignedUploadUrl(req: Request, res: Response) {
    try {
      const { fileName, contentType } = req.body;
      if (!fileName) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('fileName is required'));
      }

      const safeName = fileName.replace(/[^a-zA-Z0-9_\-.]/g, '_');
      const s3Key = `uploads/sessions/${Date.now()}_${safeName}`;

      if (S3Storage.isS3Enabled()) {
        const uploadUrl = await S3Storage.getUploadPresignedUrl(s3Key, contentType || 'application/octet-stream', 3600);
        const fileUrl = `/api/storage/file?key=${encodeURIComponent(s3Key)}`;
        return res.status(HTTP_STATUS.OK).json(successResponse({
          direct: true,
          uploadUrl,
          key: s3Key,
          fileUrl,
        }, 'Presigned upload URL generated'));
      }

      return res.status(HTTP_STATUS.OK).json(successResponse({
        direct: false,
      }, 'Direct S3 upload not available; fallback to standard upload'));
    } catch (err: any) {
      logger.error(`Error generating presigned upload URL: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to generate upload URL'));
    }
  }

  static async upload(req: Request, res: Response) {
    try {
      const file = req.file;
      if (!file) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('No file provided for upload.'));
      }

      const safeName = file.originalname.replace(/[^a-zA-Z0-9_\-.]/g, '_');
      const s3Key = `uploads/sessions/${Date.now()}_${safeName}`;

      logger.info(`[StorageController] Uploading file: ${file.originalname} (size: ${file.size} bytes)`);

      if (S3Storage.isS3Enabled()) {
        logger.info(`[StorageController] S3 is enabled. Uploading to S3 Key: ${s3Key}`);
        await S3Storage.uploadBuffer(file.buffer, s3Key, file.mimetype);
      } else {
        const localPath = path.join(UPLOADS_BASE, s3Key);
        // Ensure parent folders exist
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        logger.info(`[StorageController] S3 is disabled. Saving locally to: ${localPath}`);
        fs.writeFileSync(localPath, file.buffer);
      }

      const fileUrl = `/api/storage/file?key=${encodeURIComponent(s3Key)}`;
      return res.status(HTTP_STATUS.OK).json(successResponse({ url: fileUrl }, 'File uploaded successfully.'));
    } catch (err: any) {
      logger.error(`Error uploading file: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'File upload failed.'));
    }
  }

  static async getFile(req: Request, res: Response) {
    try {
      const key = req.query.key as string;
      if (!key) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Parameter "key" is required.'));
      }

      // Sanitize key path traversal
      if (key.includes('..')) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(errorResponse('Invalid key.'));
      }

      if (S3Storage.isS3Enabled()) {
        logger.debug(`[StorageController] Serving from S3. Generating presigned URL for: ${key}`);
        const presignedUrl = await S3Storage.getPresignedUrl(key, 3600);
        return res.redirect(presignedUrl);
      } else {
        const localPath = path.join(UPLOADS_BASE, key);
        if (!fs.existsSync(localPath)) {
          logger.warn(`[StorageController] Local file not found: ${localPath}`);
          return res.status(HTTP_STATUS.NOT_FOUND).json(errorResponse('File not found.'));
        }
        logger.debug(`[StorageController] Serving local file: ${localPath}`);
        return res.sendFile(localPath);
      }
    } catch (err: any) {
      logger.error(`Error retrieving file: ${err.message}`);
      return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(errorResponse(err.message || 'Failed to retrieve file.'));
    }
  }
}
