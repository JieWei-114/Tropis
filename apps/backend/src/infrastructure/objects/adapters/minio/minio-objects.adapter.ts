import { OnModuleInit } from '@nestjs/common';
import type { Readable } from 'stream';
import * as Minio from 'minio';
import { createLogger } from '../../../../common/observability/logger';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { TenantId } from '../../../../common/keyspace';
import {
  tenantObjectKey,
  type ObjectsPort,
  type StoredObject,
  type PresignedGetOptions,
} from '../../objects.port';

export interface MinioOptions {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

/** ObjectsPort over any S3-compatible server through the MinIO client. */
export class MinioObjectsAdapter implements ObjectsPort, OnModuleInit {
  private readonly logger = createLogger('objects');
  private readonly client: Minio.Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor(options: MinioOptions, client?: Minio.Client) {
    this.client =
      client ??
      new Minio.Client({
        endPoint: options.endPoint,
        port: options.port,
        useSSL: options.useSSL,
        accessKey: options.accessKey,
        secretKey: options.secretKey,
      });
    this.bucket = options.bucket;
    this.region = options.region ?? 'us-east-1';
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureBucket();
      this.logger.info('ready', 'Object storage ready', {
        'objects.bucket': this.bucket,
      });
    } catch (err) {
      this.logger.warn(
        'unreachable',
        'Object storage is not reachable on startup; file storage is unavailable',
        {},
        err,
      );
    }
  }

  async put(
    tenantId: TenantId,
    key: string,
    data: Buffer | Readable,
    size: number,
    contentType = 'application/octet-stream',
  ): Promise<StoredObject> {
    await this.client.putObject(
      this.bucket,
      tenantObjectKey(tenantId, key),
      data,
      size,
      { 'Content-Type': contentType },
    );
    return { bucket: this.bucket, key };
  }

  async presignedGet(
    tenantId: TenantId,
    key: string,
    expirySeconds: number,
    options: PresignedGetOptions = {},
  ): Promise<string> {
    const object = tenantObjectKey(tenantId, key);
    if (!options.contentDisposition) {
      return this.client.presignedGetObject(this.bucket, object, expirySeconds);
    }
    return this.client.presignedGetObject(this.bucket, object, expirySeconds, {
      'response-content-disposition': options.contentDisposition,
    });
  }

  async delete(tenantId: TenantId, key: string): Promise<void> {
    await this.client.removeObject(this.bucket, tenantObjectKey(tenantId, key));
  }

  /** Reachable, and the bucket exists (created when missing). */
  health(): Promise<CapabilityHealth> {
    return probeCapability('minio', () => this.ensureBucket());
  }

  private async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) {
      await this.client.makeBucket(this.bucket, this.region);
      this.logger.info('bucket-created', 'Object storage bucket created', {
        'objects.bucket': this.bucket,
      });
    }
  }
}
