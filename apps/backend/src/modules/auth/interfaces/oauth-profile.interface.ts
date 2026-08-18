export interface OAuthUserProfile {
  provider: string;
  providerId: string;
  email: string;
  name: string;
  /** True only when the provider asserts the email is verified. Linking an
   *  OAuth identity to an existing account by email is ONLY safe when true —
   *  otherwise an attacker with an unverified provider email could hijack it. */
  emailVerified: boolean;
}
