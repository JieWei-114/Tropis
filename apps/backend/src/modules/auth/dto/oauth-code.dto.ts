import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class OAuthCodeDto {
  @ApiProperty({
    description: 'One-time code from the OAuth callback redirect',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code!: string;

  @ApiProperty({
    description:
      'PKCE verifier whose base64url(SHA-256) was sent as ?challenge= when the flow started',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43,128}$/, {
    message: 'verifier must be 43-128 base64url characters',
  })
  verifier!: string;
}
