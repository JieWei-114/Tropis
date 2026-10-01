import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { InprocessSigningAdapter } from './adapters/inprocess/inprocess-signing.adapter';
import { NativeSigningAdapter } from './adapters/native/native-signing.adapter';
import { SigningHealthIndicator } from './signing.health';
import { SIGNING, SIGNING_ADAPTERS, type SigningPort } from './signing.port';

/**
 * Provides SIGNING (SigningPort), adapter chosen by SIGNING_ADAPTER:
 * `inprocess` (default, Node crypto) or `native` (gRPC to the signing
 * service at SIGNING_SERVICE_URL).
 */
@Module({})
export class SigningModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (SigningModule.root ??= {
      module: SigningModule,
      providers: [
        {
          provide: SIGNING,
          inject: [ConfigService],
          useFactory: (config: ConfigService): SigningPort => {
            const adapter = selectAdapter(
              'SIGNING_ADAPTER',
              config.get<string>('SIGNING_ADAPTER'),
              SIGNING_ADAPTERS,
              'inprocess',
            );
            if (adapter === 'native') {
              return new NativeSigningAdapter(
                config.getOrThrow<string>('SIGNING_SERVICE_URL'),
              );
            }
            return new InprocessSigningAdapter();
          },
        },
        SigningHealthIndicator,
      ],
      exports: [SIGNING, SigningHealthIndicator],
    });
  }
}
