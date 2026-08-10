import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "fs";
import { logger } from "@futurespark/logger";

let s3Client: S3Client | null = null;
let initialized = false;

function getBucketName(): string {
  return process.env.AWS_S3_BUCKET_NAME || process.env.AWS_BUCKET_NAME || "";
}

function getS3Client(): S3Client | null {
  if (!initialized) {
    const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
    const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
    const AWS_REGION = process.env.AWS_REGION || "us-east-1";
    const bucket = getBucketName();

    if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && bucket) {
      logger.info(`[S3Storage] Bootstrapping AWS S3 Client for bucket: ${bucket}`);
      s3Client = new S3Client({
        region: AWS_REGION,
        credentials: {
          accessKeyId: AWS_ACCESS_KEY_ID,
          secretAccessKey: AWS_SECRET_ACCESS_KEY,
        },
      });
    } else {
      const missing = [];
      if (!AWS_ACCESS_KEY_ID) missing.push("AWS_ACCESS_KEY_ID");
      if (!AWS_SECRET_ACCESS_KEY) missing.push("AWS_SECRET_ACCESS_KEY");
      if (!bucket) missing.push("AWS_S3_BUCKET_NAME / AWS_BUCKET_NAME");
      logger.info(`[S3Storage] AWS S3 configuration not fully set (missing: ${missing.join(", ")}). Falling back to local storage.`);
    }
    initialized = true;
  }
  return s3Client;
}

export const S3Storage = {
  isS3Enabled(): boolean {
    return getS3Client() !== null;
  },

  getBucketName(): string {
    return getBucketName();
  },

  async uploadFile(localPath: string, s3Key: string, contentType?: string): Promise<string> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) {
      throw new Error("AWS S3 is not configured/enabled.");
    }

    logger.info(`[S3Storage] Uploading local file ${localPath} to S3 Key: ${s3Key}`);
    const fileStream = fs.createReadStream(localPath);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: fileStream,
      ContentType: contentType,
    });

    await client.send(command);
    logger.info(`[S3Storage] Upload finished successfully.`);
    return s3Key;
  },

  async uploadBuffer(buffer: Buffer | string, s3Key: string, contentType?: string): Promise<string> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) {
      throw new Error("AWS S3 is not configured/enabled.");
    }

    logger.info(`[S3Storage] Uploading raw buffer to S3 Key: ${s3Key}`);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: typeof buffer === "string" ? Buffer.from(buffer) : buffer,
      ContentType: contentType,
    });

    await client.send(command);
    logger.info(`[S3Storage] Buffer upload finished successfully.`);
    return s3Key;
  },

  async downloadFile(s3Key: string, destinationLocalPath: string): Promise<string> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) {
      throw new Error("AWS S3 is not configured/enabled.");
    }

    logger.info(`[S3Storage] Downloading S3 Key ${s3Key} to local path: ${destinationLocalPath}`);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
    });

    const response = await client.send(command);
    const body = response.Body;

    if (!body) {
      throw new Error(`S3 object ${s3Key} body is empty.`);
    }

    const writeStream = fs.createWriteStream(destinationLocalPath);
    const stream = body as any;

    await new Promise<void>((resolve, reject) => {
      stream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      stream.on("error", reject);
    });

    logger.info(`[S3Storage] Download finished successfully.`);
    return destinationLocalPath;
  },

  async downloadBuffer(s3Key: string): Promise<string> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) {
      throw new Error("AWS S3 is not configured/enabled.");
    }

    logger.info(`[S3Storage] Downloading S3 Key ${s3Key} directly to memory string`);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
    });

    const response = await client.send(command);
    const body = response.Body;

    if (!body) {
      throw new Error(`S3 object ${s3Key} body is empty.`);
    }

    const str = await body.transformToString();
    return str;
  },

  /**
   * Is this key actually in the bucket?
   *
   * `getPresignedUrl` signs any key it is handed, existing or not, so a caller
   * that redirects blindly sends the browser to a URL that answers with S3's
   * NoSuchKey XML. Callers with another source for the file — a Drive stream,
   * say — should check here first and fall through instead.
   *
   * Returns false on any error, including permission problems: the caller's
   * fallback is always safer than a redirect that might 404.
   */
  async objectExists(s3Key: string): Promise<boolean> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) return false;
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
      return true;
    } catch {
      return false;
    }
  },

  async getPresignedUrl(s3Key: string, expiresInSeconds: number = 3600): Promise<string> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) {
      throw new Error("AWS S3 is not configured/enabled.");
    }

    logger.debug(`[S3Storage] Generating GET presigned URL for key: ${s3Key} (expires in ${expiresInSeconds}s)`);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: s3Key,
    });

    const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    return url;
  },

  async getUploadPresignedUrl(s3Key: string, contentType?: string, expiresInSeconds: number = 3600): Promise<string> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) {
      throw new Error("AWS S3 is not configured/enabled.");
    }

    logger.debug(`[S3Storage] Generating PUT presigned upload URL for key: ${s3Key} (expires in ${expiresInSeconds}s)`);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    return url;
  },

  async deleteFile(s3Key: string): Promise<void> {
    const client = getS3Client();
    const bucket = getBucketName();
    if (!client || !bucket) {
      throw new Error("AWS S3 is not configured/enabled.");
    }

    logger.info(`[S3Storage] Deleting S3 Key: ${s3Key}`);
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: s3Key,
    });

    await client.send(command);
    logger.info(`[S3Storage] Delete finished successfully.`);
  },
};
