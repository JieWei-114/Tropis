export interface OAuthUserProfile {
  provider: string;
  providerId: string;
  email: string;
  name: string;
  /** True only when the provider asserts the email is verified. Sign-in never
   *  links by email: only an account this provider created is matched. */
  emailVerified: boolean;
}
