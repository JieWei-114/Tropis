import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { clearToken } from '../lib/api';
import { Button } from '@/components/ui/button';
import { parseApiError } from '../lib/error';
import { LoginForm } from '../features/auth';
import { UserTable } from '../features/users';
import { UserModal } from '../features/users';
import {
  useUsers,
  useUserSearch,
  useSimilarUsers,
  useCreateUser,
  useReplaceUser,
  useDeleteUser,
  useUploadAvatar,
} from '../state/tanstack/useUsersQuery';
import type { User, CreateUserPayload, ReplaceUserPayload } from '../lib/api';

interface Props {
  authed: boolean;
  onLogin: (token: string) => void;
  onLogout: () => void;
}

export function UsersPage({ authed, onLogin, onLogout }: Props) {
  const { t } = useTranslation();
  // ── UI state (local — not server data) ────────────────────────────
  const [modalUser, setModalUser] = useState<User | null | 'new'>(null);
  const [lastAction, setLastAction] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [similarId, setSimilarId] = useState<string | null>(null);
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});
  const [avatarUser, setAvatarUser] = useState<User | null>(null);
  const [actionError, setActionError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Server state — TanStack Query ────────────────────────────────
  const { data: allUsers = [], isLoading, error } = useUsers();
  const { data: searchResults = [], isFetching: searching } =
    useUserSearch(debouncedQ);
  const { data: similarUsers = [] } = useSimilarUsers(similarId);

  const createMutation = useCreateUser();
  const replaceMutation = useReplaceUser();
  const deleteMutation = useDeleteUser();
  const uploadAvatarMutation = useUploadAvatar();

  // Derive displayed list: similar > search > all
  const displayUsers: User[] = similarId
    ? similarUsers
    : debouncedQ
      ? searchResults
      : allUsers;

  // ── Handlers ──────────────────────────────────────────────────────

  const handleSearchChange = (q: string) => {
    setSearchQuery(q);
    setSimilarId(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) {
      setDebouncedQ('');
      return;
    }
    searchTimer.current = setTimeout(() => setDebouncedQ(q), 350);
  };

  const handleFindSimilar = (user: User) => {
    setSimilarId(user.id);
    setSearchQuery('');
    setDebouncedQ('');
    setLastAction(t('users.actions.showingSimilarTo', { name: user.name }));
  };

  const handleClearSimilar = () => {
    setSimilarId(null);
    setLastAction('');
  };

  const handleAvatarClick = (user: User) => {
    setAvatarUser(user);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !avatarUser) return;
    const user = avatarUser;
    e.target.value = '';
    setAvatarUser(null);
    const url = await uploadAvatarMutation.mutateAsync({
      userId: user.id,
      file,
    });
    setAvatarUrls((prev) => ({ ...prev, [user.id]: url }));
    setLastAction(t('users.actions.avatarUploaded', { name: user.name }));
  };

  const handleSave = async (
    data: CreateUserPayload | ReplaceUserPayload,
    method: 'POST' | 'PUT',
  ) => {
    try {
      setActionError('');
      if (method === 'POST') {
        const created = await createMutation.mutateAsync(
          data as CreateUserPayload,
        );
        setLastAction(t('users.actions.created', { name: created.name }));
      } else {
        const editingUser = modalUser as User;
        const updated = await replaceMutation.mutateAsync({
          id: editingUser.id,
          data: data as ReplaceUserPayload,
        });
        setLastAction(t('users.actions.updated', { name: updated.name }));
      }
      setModalUser(null);
    } catch (err) {
      setActionError(parseApiError(err).message);
    }
  };

  const handleDelete = async (user: User) => {
    try {
      setActionError('');
      await deleteMutation.mutateAsync(user.id);
      setLastAction(t('users.actions.deleted', { name: user.name }));
    } catch (err) {
      setActionError(parseApiError(err).message);
    }
  };

  const handleLogout = () => {
    clearToken();
    onLogout();
  };

  // ── Render ────────────────────────────────────────────────────────

  if (!authed) return <LoginForm onLogin={onLogin} />;

  const errorMsg =
    actionError ||
    (error instanceof Error ? error.message : error ? String(error) : '');

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-heading">{t('users.title')}</h2>
          <p className="mt-[3px] text-xs text-muted">
            gRPC{' '}
            <span className="font-mono text-primary-soft">UserService</span> ·
            MongoDB · Redis cache · Elasticsearch · pgvector · MinIO
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lastAction && (
            <span className="rounded-md border border-success/25 bg-success/10 px-2.5 py-1 text-xs text-success">
              {lastAction}
            </span>
          )}
          <Button onClick={() => setModalUser('new')}>
            {t('users.newUser')}
          </Button>
          <Button variant="secondary" onClick={handleLogout}>
            {t('users.logout')}
          </Button>
        </div>
      </div>

      {/* ── Search bar ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[260px] flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5">
          <span className="text-sm" aria-hidden="true">
            🔍
          </span>
          <input
            aria-label={t('users.searchPlaceholder')}
            className="flex-1 border-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
            placeholder={t('users.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {searching && <span className="text-xs text-primary">…</span>}
        </div>
        {similarId && (
          <span className="rounded-md border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs text-primary-soft">
            {t('users.showingSimilar')}
            <button
              className="cursor-pointer border-none bg-transparent px-1 text-xs text-primary"
              onClick={handleClearSimilar}
            >
              {' '}
              {t('users.clearSimilar')}
            </button>
          </span>
        )}
      </div>

      {errorMsg && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {errorMsg}
        </p>
      )}

      {/* Hidden file input for avatar upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleFileChange(e);
        }}
      />

      {isLoading ? (
        <p className="text-[13px] text-muted">{t('common.loading')}</p>
      ) : (
        <UserTable
          users={displayUsers}
          avatarUrls={avatarUrls}
          onEdit={(u) => setModalUser(u)}
          onDelete={(u) => {
            void handleDelete(u);
          }}
          onFindSimilar={handleFindSimilar}
          onUploadAvatar={handleAvatarClick}
        />
      )}

      {similarId && similarUsers.length > 0 && (
        <p className="mt-2 text-[11px] text-muted">
          {t('users.similarFooter', { total: similarUsers.length })}
        </p>
      )}

      {modalUser !== null && (
        <UserModal
          user={modalUser === 'new' ? null : modalUser}
          onClose={() => setModalUser(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
