import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import * as Minio from 'minio';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: Minio.Client;
  private readonly defaultBucket: string;

  constructor(private readonly config: ConfigService) {
    this.client = new Minio.Client({
      endPoint: config.get('MINIO_ENDPOINT', 'localhost'),
      port: config.get<number>('MINIO_PORT', 9900),
      useSSL: config.get('MINIO_USE_SSL') === 'true',
      accessKey: config.get('MINIO_ACCESS_KEY', 'minioadmin'),
      secretKey: config.get('MINIO_SECRET_KEY', 'minioadmin123'),
    });
    this.defaultBucket = config.get('MINIO_BUCKET', 'app-uploads');
  }

  async onModuleInit() {
    try {
      await this.ensureBucket(this.defaultBucket);
      this.logger.log(`MinIO ready — bucket: ${this.defaultBucket}`);
    } catch {
      this.logger.warn(
        'MinIO not reachable on startup — file storage unavailable',
      );
    }
  }

  async ensureBucket(bucket: string): Promise<void> {
    const exists = await this.client.bucketExists(bucket);
    if (!exists) {
      await this.client.makeBucket(bucket, 'us-east-1');
      this.logger.log(`Created bucket: ${bucket}`);
    }
  }

  async upload(
    objectName: string,
    data: Buffer | Readable,
    size: number,
    contentType = 'application/octet-stream',
    bucket = this.defaultBucket,
  ): Promise<string> {
    await this.client.putObject(bucket, objectName, data, size, {
      'Content-Type': contentType,
    });
    return `${bucket}/${objectName}`;
  }

  async getSignedUrl(
    objectName: string,
    expirySeconds = 3600,
    bucket = this.defaultBucket,
  ): Promise<string> {
    return this.client.presignedGetObject(bucket, objectName, expirySeconds);
  }

  async delete(objectName: string, bucket = this.defaultBucket): Promise<void> {
    await this.client.removeObject(bucket, objectName);
  }

  async listObjects(
    prefix = '',
    bucket = this.defaultBucket,
  ): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const names: string[] = [];
      const stream = this.client.listObjects(bucket, prefix, true);
      stream.on('data', (obj) => {
        if (obj.name) names.push(obj.name);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(names));
    });
  }

  /** Health probe — verifies MinIO is reachable and the default bucket exists or is listable. */
  async ping(): Promise<void> {
    const ok = await this.client.bucketExists(this.defaultBucket);
    if (!ok) {
      await this.ensureBucket(this.defaultBucket);
    }
  }
}
