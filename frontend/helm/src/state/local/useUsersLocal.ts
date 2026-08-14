/**
 * LOCAL STATE — Pattern 1 of 3
 *
 * Pure React: useState + useEffect + useCallback.
 * No external library. All state lives inside the component tree.
 *
 * ✅ Simple, zero dependencies
 * ❌ State is lost when component unmounts
 * ❌ No shared state between components (must prop-drill)
 * ❌ Duplicated fetches if same data needed in multiple places
 * ❌ No automatic background refetch or cache
 */

import { useState, useEffect, useCallback } from 'react';
import {
  fetchUsers,
  createUser,
  replaceUser,
  deleteUser,
  type User,
  type CreateUserPayload,
  type ReplaceUserPayload,
} from '../../lib/api';

export function useUsersLocal() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await fetchUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount — re-fetch every time the component mounts
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (data: CreateUserPayload) => {
    const user = await createUser(data);
    setUsers((prev) => [user, ...prev]); // optimistic prepend
    return user;
  };

  const replace = async (id: string, data: ReplaceUserPayload) => {
    const user = await replaceUser(id, data);
    setUsers((prev) => prev.map((u) => (u.id === id ? user : u)));
    return user;
  };

  const remove = async (id: string) => {
    await deleteUser(id);
    setUsers((prev) => prev.filter((u) => u.id !== id));
  };

  return { users, loading, error, refetch: load, create, replace, remove };
}
