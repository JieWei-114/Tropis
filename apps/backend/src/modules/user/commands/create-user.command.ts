import { ICommand, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DOCUMENTS,
  type DocumentsPort,
} from '../../../infrastructure/documents/documents.port';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { IUserResponse } from '../interfaces/user.interface';
import {
  CREATE_REQUEST_DEDUP,
  CREATE_RESPONSE_KEY,
  IDEMPOTENCY_TTL_SECONDS,
  PASSWORD_MIN_LENGTH,
  USER_ERROR_CODES,
  USER_EVENTS,
  USER_TOPIC,
} from '../constants/user.constants';
import { UserCreatedEvent } from '../events/user.events';
import { UserEventStoreService } from '../event-store/user-event-store.service';
import { AppError } from '../../../common/errors';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  DEDUP,
  type DedupPort,
} from '../../../infrastructure/dedup/dedup.port';
import { KV, type KvPort } from '../../../infrastructure/kv/kv.port';
import { TenantContext } from '../../../common/tenant/tenant.context';
import type { TenantId } from '../../../common/keyspace';

const BCRYPT_SALT = 12;

/** Identity at an OAuth provider, for accounts that have no password. */
export interface ProviderIdentity {
  provider: string;
  providerId: string;
}

export class CreateUserCommand implements ICommand {
  constructor(
    public readonly name: string,
    public readonly email: string,
    public readonly password: string,
    public readonly age?: number,
    public readonly idempotencyKey?: string,
    public readonly identity?: ProviderIdentity,
    /**
     * Who asks: `user:<id>` for an authenticated caller, `ip:<address>` for
     * an anonymous one. Idempotency keys are scoped to it, so one caller can
     * never receive another's stored response.
     */
    public readonly requester = 'anonymous',
  ) {}
}

@CommandHandler(CreateUserCommand)
export class CreateUserHandler implements ICommandHandler<
  CreateUserCommand,
  IUserResponse
> {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly eventStore: UserEventStoreService,
    private readonly outboxService: OutboxService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(DOCUMENTS) private readonly documents: DocumentsPort,
    @Inject(DEDUP) private readonly dedup: DedupPort,
    @Inject(KV) private readonly kv: KvPort,
    private readonly tenantCtx: TenantContext,
  ) {}

  async execute(cmd: CreateUserCommand): Promise<IUserResponse> {
    // Resolved once: the uniqueness pre-check, the insert and the idempotency
    // key must all agree on the tenant.
    const tenant = this.tenantCtx.tenant;
    // Idempotency: the first request with a key claims it; a repeat returns
    // the stored response. A repeat that arrives before the first stored its
    // response (or after it failed) runs normally, and the email uniqueness
    // check decides.
    let claimed = false;
    const owner = randomUUID();
    const scope = cmd.requester;
    if (cmd.idempotencyKey) {
      claimed = await this.dedup.claim(
        CREATE_REQUEST_DEDUP.forTenant(tenant, scope, cmd.idempotencyKey),
        IDEMPOTENCY_TTL_SECONDS,
        owner,
      );
      if (!claimed) {
        const stored = await this.kv.get<IUserResponse>(
          CREATE_RESPONSE_KEY.forTenant(tenant, scope, cmd.idempotencyKey),
        );
        if (stored) return stored;
      }
    }

    try {
      return await this.createUser(cmd, tenant);
    } catch (err) {
      // Free the key so a retry of a failed request is not treated as a repeat.
      if (claimed && cmd.idempotencyKey) {
        await this.dedup
          .release(
            CREATE_REQUEST_DEDUP.forTenant(tenant, scope, cmd.idempotencyKey),
            owner,
          )
          .catch(() => undefined);
      }
      throw err;
    }
  }

  private async createUser(
    cmd: CreateUserCommand,
    tenantId: TenantId,
  ): Promise<IUserResponse> {
    if (
      !cmd.identity &&
      (!cmd.password || cmd.password.length < PASSWORD_MIN_LENGTH)
    ) {
      throw AppError.validation([
        {
          field: 'password',
          description: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        },
      ]);
    }

    const existing = await this.userRepo.findByEmail(tenantId, cmd.email);
    if (existing) throw new AppError(USER_ERROR_CODES.ALREADY_EXISTS);

    const passwordHash = cmd.identity
      ? ''
      : await bcrypt.hash(cmd.password, BCRYPT_SALT);

    // Atomic transaction: user write + event-store append + outbox write all commit or all roll back.
    // The outbox relay then publishes to Pulsar independently — guaranteed at-least-once delivery.
    let user: Awaited<ReturnType<typeof this.userRepo.create>>;

    try {
      await this.documents.withTransaction(async (tx) => {
        // Roles are never assigned here: this path is reachable without
        // authentication (self-service registration), so granting a role from
        // request data would be a privilege-escalation hole. New users get the
        // schema default (member); admins grant more through the admin-only
        // roles endpoint or `scripts/promote-admin.ts`.
        user = await this.userRepo.create(
          tenantId,
          {
            name: cmd.name,
            email: cmd.email,
            passwordHash,
            age: cmd.age,
            ...cmd.identity,
          },
          tx,
        );
        const userId = user._id.toString();

        await this.eventStore.append(
          tenantId,
          userId,
          'UserCreated',
          {
            name: cmd.name,
            email: cmd.email,
            age: cmd.age,
          },
          tx,
        );

        await this.outboxService.write(
          {
            topic: USER_TOPIC,
            aggregateId: userId,
            type: USER_EVENTS.CREATED,
            tenantId,
            data: {
              userId,
              tenantId,
              name: cmd.name,
              email: cmd.email,
            },
          },
          tx,
        );
      });
    } catch (err) {
      // The pre-check above is not atomic: two concurrent creates with the same
      // email both pass it and one loses the unique-index race. Report the
      // intended conflict instead of leaking a raw driver error as a 500.
      if ((err as { code?: number }).code === 11000) {
        throw new AppError(USER_ERROR_CODES.ALREADY_EXISTS, { cause: err });
      }
      throw err;
    }

    const userId = user!._id.toString();
    this.eventEmitter.emit(
      UserCreatedEvent.EVENT,
      new UserCreatedEvent(tenantId, userId, user!.name, user!.email),
    );

    const response = UserTransformer.toResponse(user!);

    if (cmd.idempotencyKey) {
      // Fire-and-forget — a store failure must not fail the request
      this.kv
        .set(
          CREATE_RESPONSE_KEY.forTenant(
            tenantId,
            cmd.requester,
            cmd.idempotencyKey,
          ),
          response,
          { ttlSeconds: IDEMPOTENCY_TTL_SECONDS },
        )
        .catch(() => {});
    }

    return response;
  }
}
