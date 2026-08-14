/**
 * Typed fetch helpers for REST-only endpoints (multipart uploads etc.)
 * that don't go through gRPC-Web.
 */

export interface RestOptions {
  /** REST API origin, e.g. http://localhost:3100 (the SDK appends /api). */
  baseUrl: string;
  /** Returns the current bearer token, or null when unauthenticated. */
  getToken?: () => string | null;
}

export interface RestClient {
  /** POST /api/users/:id/avatar — multipart upload, returns the avatar URL. */
  uploadAvatar(userId: string, file: File): Promise<string>;
}

export function createRestClient(options: RestOptions): RestClient {
  const { baseUrl, getToken } = options;
  const apiBase = `${baseUrl}/api`;

  const authHeaders = (): Record<string, string> => {
    const token = getToken?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  return {
    async uploadAvatar(userId: string, file: File): Promise<string> {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${apiBase}/users/${userId}/avatar`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      });
      if (!res.ok) throw new Error(`Avatar upload failed: ${res.status}`);
      const data = (await res.json()) as { url: string };
      return data.url;
    },
  };
}
