import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { LogMailAdapter } from './adapters/log/log-mail.adapter';
import { SmtpMailAdapter } from './adapters/smtp/smtp-mail.adapter';
import { MailHealthIndicator } from './mail.health';
import { MAIL, MAIL_ADAPTERS, type MailPort } from './mail.port';

/** Provides MAIL (MailPort), adapter chosen by MAIL_ADAPTER. */
@Module({})
export class MailModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    return (MailModule.root ??= {
      module: MailModule,
      providers: [
        {
          provide: MAIL,
          inject: [ConfigService],
          useFactory: (config: ConfigService): MailPort => {
            const adapter = selectAdapter(
              'MAIL_ADAPTER',
              config.get<string>('MAIL_ADAPTER'),
              MAIL_ADAPTERS,
              'smtp',
            );
            if (adapter === 'log') return new LogMailAdapter();
            return new SmtpMailAdapter({
              host: config.getOrThrow('SMTP_HOST'),
              port: Number(config.getOrThrow<number>('SMTP_PORT')),
              user: config.get<string>('SMTP_USER') || undefined,
              pass: config.get<string>('SMTP_PASS', ''),
              from: config.getOrThrow('SMTP_FROM'),
            });
          },
        },
        MailHealthIndicator,
      ],
      exports: [MAIL, MailHealthIndicator],
    });
  }
}
