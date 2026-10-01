import { IsString, MaxLength } from 'class-validator';

/**
 * tropis.auth.v1.AuthService Login. Bounded only: a malformed email or a
 * short password answers AUTH_INVALID_CREDENTIALS like a wrong one.
 */
export class LoginRpcDto {
  @IsString()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MaxLength(128)
  password!: string;
}
