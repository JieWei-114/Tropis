import { ApiProperty } from '@nestjs/swagger';

/** Body of login, refresh and the OAuth exchange for the web console; the refresh token is the `tropis_rt` cookie. */
export class AccessTokenDto {
  @ApiProperty()
  accessToken!: string;
}

/** GET /api/auth/me. */
export class CurrentUserDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty({ type: [String] })
  roles!: string[];
}

/**
 * Body of login, the OAuth exchange and the native refresh for a native
 * shell (`X-Tropis-Client: native`), which keeps the refresh token in OS
 * secure storage.
 */
export class NativeSessionDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;
}
