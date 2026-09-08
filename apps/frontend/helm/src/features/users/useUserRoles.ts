/**
 * USERS FEATURE — role management.
 *
 * Roles live on REST (`/api/users/roles`, `PATCH /api/users/:id/roles`) rather
 * than gRPC because the proto's UserResponse has no roles field. Changing roles
 * requires the `manage_roles` permission, which OPA grants to `admin` only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { env } from '../../lib/env';
import { getToken } from '../../lib/api';

const BASE = `${env.VITE_API_BASE_URL}/api/users`;

export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Roles of the signed-in user, read from the JWT's `roles` claim. */
function currentUserRoles(): string[] {
  const token = getToken();
  if (!token) return [];
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { roles?: unknown };
    return Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  } catch {
    return [];
  }
}

export function useUserRoles() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['users', 'roles'],
    queryFn: async (): Promise<Record<string, string[]>> => {
      const res = await fetch(`${BASE}/roles`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`roles ${res.status}`);
      return (await res.json()) as Record<string, string[]>;
    },
    staleTime: 15_000,
    // The endpoint is admin-only: a 403 is a permanent answer for this user,
    // so retrying it 3x (react-query's default) is pure noise.
    retry: false,
  });

  const setRoles = useMutation({
    mutationFn: async ({ id, roles }: { id: string; roles: Role[] }) => {
      const res = await fetch(`${BASE}/${id}/roles`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ roles }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message ?? `roles ${res.status}`);
      }
      return (await res.json()) as { id: string; roles: string[] };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', 'roles'] });
    },
  });

  return {
    rolesByUser: query.data ?? {},
    isLoading: query.isLoading,
    /** Set when the roles map could not be read (e.g. 403 for a non-admin). */
    error: query.error,
    setRoles,
    isAdmin: currentUserRoles().includes('admin'),
  };
}
