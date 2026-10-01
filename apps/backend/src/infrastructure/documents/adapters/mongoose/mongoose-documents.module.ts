import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { DOCUMENTS } from '../../documents.port';
import { MongooseDocumentsAdapter } from './mongoose-documents.adapter';

/**
 * MongoDB root connection. Feature modules register their own schemas via
 * MongooseModule.forFeature(); this module owns the connection.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URI'),
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000, // TCP connection timeout
        socketTimeoutMS: 10_000, // idle socket timeout — kills hung queries
      }),
    }),
  ],
  providers: [
    {
      provide: DOCUMENTS,
      inject: [getConnectionToken()],
      useFactory: (connection: Connection) =>
        new MongooseDocumentsAdapter(connection),
    },
  ],
  exports: [DOCUMENTS],
})
export class MongooseDocumentsModule {}
