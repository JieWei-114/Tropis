/**
 * USERS FEATURE — role management.
 *
 * Roles live on REST (`/api/users/roles`, paged, and `PATCH
 * /api/users/:id/roles`) rather than RPC because the proto's UserResponse has
 * no roles field; the SDK wraps both endpoints. The hook reads every page
 * into one map keyed by user id. Changing roles
 * requires the `manage_roles` permission, which OPA grants to `admin` only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getToken, getUserRoles, setUserRoles } from '../../lib/api';
import { parseApiError } from '../../lib/error';

const ROLES_PAGE_SIZE = 100;

/** Every page of the roles listing, merged into one map keyed by user id. */
async function readAllRoles(): Promise<Record<string, string[]>> {
  const byUser: Record<string, string[]> = {};
  const seen = new Set<string>();
  let pageToken = '';
  do {
    seen.add(pageToken);
    const page = await getUserRoles({ pageSize: ROLES_PAGE_SIZE, pageToken });
    for (const { userId, roles } of page.items) byUser[userId] = roles;
    pageToken = page.nextPageToken;
  } while (pageToken && !seen.has(pageToken));
  return byUser;
}

export const ROLES = ['admin', 'editor', 'viewer', 'member'] as const;
export type Role = (typeof ROLES)[number];

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
    queryFn: readAllRoles,
    staleTime: 15_000,
    // The endpoint is admin-only: a 403 is a permanent answer for this user,
    // so retrying it 3x (react-query's default) is pure noise.
    retry: false,
  });

  const setRoles = useMutation({
    mutationFn: async ({ id, roles }: { id: string; roles: Role[] }) => {
      try {
        return await setUserRoles(id, roles);
      } catch (err) {
        // The problem's detail or title, never a bare status.
        throw new Error(parseApiError(err).message);
      }
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
