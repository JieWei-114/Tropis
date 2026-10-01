import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ProtoOptional } from '../../../infrastructure/rpc/rpc-validate.decorator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../constants/user.constants';
import { UserStatus } from '../constants/user.enums';

/**
 * Request rules of tropis.user.v1.UserService, checked by the RPC
 * validation interceptor before a handler runs. Properties are the
 * generated field names; a proto3 zero value ('' or 0) means "not set".
 */

/** A display name: bounded, no markup and no control characters. */
const NAME_PATTERN = /^[^<>\p{Cc}]+$/u;
const NAME_MAX = 100;
/** RFC 5321 path limit. */
export const EMAIL_MAX = 254;
const ID_MAX = 64;
const STATUSES = Object.values(UserStatus);
/** Page sizes are clamped by the handlers; this only rejects nonsense. */
const PAGE_SIZE_MAX = 2_147_483_647;

class UserIdRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX)
  id!: string;
}

export class CreateUserRpcDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX)
  @Matches(NAME_PATTERN, {
    message: 'name must not contain markup or control characters',
  })
  name!: string;

  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ProtoOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age!: number;

  @ProtoOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[\x21-\x7e]+$/, {
    message: 'idempotencyKey must be printable ASCII without spaces',
  })
  idempotencyKey!: string;
}

export class FindAllRpcDto {
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  page!: number;

  @IsInt()
  @Min(0)
  @Max(PAGE_SIZE_MAX)
  limit!: number;

  @IsInt()
  @Min(0)
  @Max(PAGE_SIZE_MAX)
  pageSize!: number;

  @IsString()
  @MaxLength(512)
  pageToken!: string;
}

export class FindByIdRpcDto extends UserIdRequest {}

export class DeleteUserRpcDto extends UserIdRequest {}

export class UpdateUserRpcDto extends UserIdRequest {
  @ProtoOptional()
  @IsString()
  @MaxLength(NAME_MAX)
  @Matches(NAME_PATTERN, {
    message: 'name must not contain markup or control characters',
  })
  name!: string;

  @ProtoOptional()
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;

  @ProtoOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ProtoOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age!: number;

  @ProtoOptional()
  @IsIn(STATUSES)
  status!: string;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;
}

export class ReplaceUserRpcDto extends UserIdRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX)
  @Matches(NAME_PATTERN, {
    message: 'name must not contain markup or control characters',
  })
  name!: string;

  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;

  @IsIn(STATUSES)
  status!: string;

  @ProtoOptional()
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ProtoOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age!: number;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;
}

export class SearchUsersRpcDto {
  @IsString()
  @MaxLength(200)
  query!: string;

  @IsInt()
  @Min(0)
  @Max(PAGE_SIZE_MAX)
  size!: number;

  @IsInt()
  @Min(0)
  @Max(PAGE_SIZE_MAX)
  pageSize!: number;
}

export class FindSimilarRpcDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ID_MAX)
  userId!: string;

  @IsInt()
  @Min(0)
  @Max(PAGE_SIZE_MAX)
  limit!: number;

  @IsInt()
  @Min(0)
  @Max(PAGE_SIZE_MAX)
  pageSize!: number;
}

export class GetUserByEmailRpcDto {
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;
}
