import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpaPolicyAdapter } from './adapters/opa/opa-policy.adapter';
import { PolicyHealthIndicator } from './policy.health';
import { POLICY, type PolicyPort } from './policy.port';

/**
 * Provides POLICY (PolicyPort) over OPA. There is deliberately no `disabled`
 * adapter: switching authorization off is not a configuration choice.
 */
@Module({})
export class PolicyModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (PolicyModule.root ??= {
      module: PolicyModule,
      providers: [
        {
          provide: POLICY,
          inject: [ConfigService],
          useFactory: (config: ConfigService): PolicyPort =>
            new OpaPolicyAdapter(
              config.getOrThrow<string>('OPA_URL'),
              config.get<string>('OPA_TOKEN') || undefined,
            ),
        },
        PolicyHealthIndicator,
      ],
      exports: [POLICY, PolicyHealthIndicator],
    });
  }
}
