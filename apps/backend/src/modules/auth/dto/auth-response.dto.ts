import { ApiProperty } from '@nestjs/swagger';

/** Body of login, refresh and the OAuth exchange; the refresh token is the `tropis_rt` cookie. */
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
