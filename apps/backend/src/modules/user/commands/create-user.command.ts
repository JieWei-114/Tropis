import { ICommand, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { BadRequestException, ConflictException, Inject } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type Redis from 'ioredis';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { IUserResponse } from '../interfaces/user.interface';
import {
  PASSWORD_MIN_LENGTH,
  USER_ERROR_CODES,
  USER_EVENTS,
} from '../constants/user.constants';
import { UserCreatedEvent } from '../events/user.events';
import { UserEventStoreService } from '../event-store/user-event-store.service';
import { ERROR_CODES } from '@tropis/shared';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { TenantContext } from '../../../common/tenant/tenant.context';

const BCRYPT_SALT = 12;

export class CreateUserCommand implements ICommand {
  constructor(
    public readonly name: string,
    public readonly email: string,
    public readonly password: string,
    public readonly age?: number,
    public readonly idempotencyKey?: string,
  ) {}
}

const IDEMPOTENCY_TTL_S = 86_400; // 24 h

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
    @InjectConnection() private readonly connection: Connection,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly tenantCtx: TenantContext,
  ) {}

  async execute(cmd: CreateUserCommand): Promise<IUserResponse> {
    // Resolved once: the uniqueness pre-check, the insert and the idempotency
    // key must all agree on the tenant.
    const tenantId = this.tenantCtx.tenantId;
    // Idempotency: if caller supplies a key, return the cached response for duplicate requests
    if (cmd.idempotencyKey) {
      const cached = await this.redis.get(
        `idem:create-user:${tenantId}:${cmd.idempotencyKey}`,
      );
      if (cached) return JSON.parse(cached) as IUserResponse;
    }

    if (!cmd.password || cmd.password.length < PASSWORD_MIN_LENGTH) {
      throw new BadRequestException({
        code: ERROR_CODES.BAD_REQUEST,
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      });
    }

    const existing = await this.userRepo.findByEmail(cmd.email, tenantId);
    if (existing)
      throw new ConflictException({
        code: USER_ERROR_CODES.ALREADY_EXISTS,
        message: 'A user with this email already exists',
      });

    const passwordHash = await bcrypt.hash(cmd.password, BCRYPT_SALT);

    // Atomic transaction: user write + event-store append + outbox write all commit or all roll back.
    // The outbox relay then publishes to Pulsar independently — guaranteed at-least-once delivery.
    const session = await this.connection.startSession();
    let user: Awaited<ReturnType<typeof this.userRepo.create>>;

    try {
      await session.withTransaction(async () => {
        // Roles are never assigned here: this path is reachable without
        // authentication (self-service registration), so granting a role from
        // request data would be a privilege-escalation hole. New users get the
        // schema default (editor); admins are granted out-of-band by
        // `scripts/promote-admin.ts` or the admin-only roles endpoint.
        user = await this.userRepo.createWithSession(
          {
            name: cmd.name,
            email: cmd.email,
            passwordHash,
            age: cmd.age,
            tenantId,
          },
          session,
        );
        const userId = user._id.toString();

        await this.eventStore.appendWithSession(
          userId,
          'UserCreated',
          {
            name: cmd.name,
            email: cmd.email,
            age: cmd.age,
          },
          session,
        );

        await this.outboxService.write(
          userId,
          USER_EVENTS.CREATED,
          {
            userId,
            name: cmd.name,
            email: cmd.email,
          },
          session,
        );
      });
    } catch (err) {
      // The pre-check above is not atomic: two concurrent creates with the same
      // email both pass it and one loses the unique-index race. Report the
      // intended conflict instead of leaking a raw driver error as a 500.
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictException({
          code: USER_ERROR_CODES.ALREADY_EXISTS,
          message: 'A user with this email already exists',
        });
      }
      throw err;
    } finally {
      await session.endSession();
    }

    const userId = user!._id.toString();
    this.eventEmitter.emit(
      UserCreatedEvent.EVENT,
      new UserCreatedEvent(userId, user!.name, user!.email),
    );

    const response = UserTransformer.toResponse(user!);

    if (cmd.idempotencyKey) {
      // Fire-and-forget — a Redis failure must not fail the request
      this.redis
        .set(
          `idem:create-user:${tenantId}:${cmd.idempotencyKey}`,
          JSON.stringify(response),
          'EX',
          IDEMPOTENCY_TTL_S,
        )
        .catch(() => {});
    }

    return response;
  }
}
