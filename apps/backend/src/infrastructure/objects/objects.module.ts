import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { DisabledObjectsAdapter } from './adapters/disabled/disabled-objects.adapter';
import { MinioObjectsAdapter } from './adapters/minio/minio-objects.adapter';
import { ObjectsHealthIndicator } from './objects.health';
import { OBJECTS, OBJECTS_ADAPTERS, type ObjectsPort } from './objects.port';

/** Provides OBJECTS (ObjectsPort), adapter chosen by OBJECTS_ADAPTER. */
@Module({})
export class ObjectsModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (ObjectsModule.root ??= {
      module: ObjectsModule,
      providers: [
        {
          provide: OBJECTS,
          inject: [ConfigService],
          useFactory: (config: ConfigService): ObjectsPort => {
            const adapter = selectAdapter(
              'OBJECTS_ADAPTER',
              config.get<string>('OBJECTS_ADAPTER'),
              OBJECTS_ADAPTERS,
              'minio',
            );
            if (adapter === 'disabled') return new DisabledObjectsAdapter();
            return new MinioObjectsAdapter({
              endPoint: config.getOrThrow('MINIO_ENDPOINT'),
              port: Number(config.getOrThrow<number>('MINIO_PORT')),
              useSSL: config.getOrThrow('MINIO_USE_SSL') === 'true',
              accessKey: config.getOrThrow('MINIO_ACCESS_KEY'),
              secretKey: config.getOrThrow('MINIO_SECRET_KEY'),
              bucket: config.getOrThrow('MINIO_BUCKET'),
            });
          },
        },
        ObjectsHealthIndicator,
      ],
      exports: [OBJECTS, ObjectsHealthIndicator],
    });
  }
}
