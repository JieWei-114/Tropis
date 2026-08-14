import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

/**
 * MongoDB (Mongoose) root connection. Feature modules register their own
 * schemas via MongooseModule.forFeature(); this module owns the connection.
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
})
export class DatabaseModule {}
