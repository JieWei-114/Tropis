import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { User } from '../../../lib/api';
import { ROLES } from '../useUserRoles';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Props {
  users: User[];
  avatarUrls?: Record<string, string>;
  onboardingByUser?: Map<string, { status: string }>;
  rolesByUser?: Record<string, string[]>;
  canManageRoles?: boolean;
  /** True while the roles map is loading — the selector stays inert. */
  rolesLoading?: boolean;
  /** True while a role change is in flight — prevents racing updates. */
  roleUpdating?: boolean;
  onChangeRole?: (user: User, role: string) => void;
  onEdit: (user: User) => void;
  onDelete: (user: User) => void;
  onFindSimilar?: (user: User) => void;
  onUploadAvatar?: (user: User) => void;
}

export function UserTable({
  users,
  avatarUrls = {},
  onboardingByUser,
  rolesByUser,
  canManageRoles = false,
  rolesLoading = false,
  roleUpdating = false,
  onChangeRole,
  onEdit,
  onDelete,
  onFindSimilar,
  onUploadAvatar,
}: Props) {
  const { t } = useTranslation();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const handleDelete = (user: User) => {
    if (confirmId === user.id) {
      setConfirmId(null);
      onDelete(user);
    } else {
      setConfirmId(user.id);
    }
  };

  if (users.length === 0) {
    return (
      <p className="py-6 text-center text-[13px] text-muted">
        {t('users.noUsers')}
      </p>
    );
  }

  return (
    <Table className="max-md:min-w-[560px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {(
            [
              'avatar',
              'name',
              'email',
              'age',
              'status',
              'logins',
              'role',
              'onboarding',
              'actions',
            ] as const
          ).map((h) => (
            <TableHead key={h}>{t(`users.table.${h}`)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => (
          <TableRow key={u.id}>
            <TableCell>
              {avatarUrls[u.id] ? (
                <button
                  type="button"
                  className="cursor-pointer rounded-full border-none bg-transparent p-0"
                  onClick={() => onUploadAvatar?.(u)}
                  title={t('users.table.changeAvatarTitle')}
                  aria-label={t('users.table.changeAvatarTitle')}
                >
                  {/* Image convention: lazy + explicit dimensions + alt */}
                  <img
                    src={avatarUrls[u.id]}
                    alt={t('users.table.avatarAlt', { name: u.name })}
                    loading="lazy"
                    width={32}
                    height={32}
                    className="h-8 w-8 rounded-full border-2 border-primary object-cover"
                  />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-faint bg-raised text-[13px] font-bold text-muted transition-colors hover:border-primary hover:text-primary-soft"
                  onClick={() => onUploadAvatar?.(u)}
                  title={t('users.table.uploadAvatarTitle')}
                  aria-label={t('users.table.uploadAvatarTitle')}
                >
                  {u.name.charAt(0).toUpperCase()}
                </button>
              )}
            </TableCell>
            <TableCell>{u.name}</TableCell>
            <TableCell className="font-mono text-xs text-primary-soft">
              {u.email}
            </TableCell>
            <TableCell>{u.age ?? '—'}</TableCell>
            <TableCell>
              <Badge
                variant={u.status === 'active' ? 'success' : 'muted'}
                className="uppercase"
              >
                {u.status}
              </Badge>
            </TableCell>
            <TableCell>{u.loginCount}</TableCell>
            <TableCell>
              {(() => {
                // Roles may be genuinely absent, still loading, or forbidden
                // (the endpoint is admin-only) — all three must read as "no
                // data", never as a concrete role we did not receive.
                const roles = rolesByUser?.[u.id];
                const role = roles?.[0] ?? '';
                // A single-select cannot represent multiple roles, and PATCH
                // REPLACES the array — so show, never silently collapse.
                if (roles && roles.length > 1)
                  return (
                    <span className="text-xs text-body">
                      {roles.join(', ')}
                    </span>
                  );
                if (!canManageRoles)
                  return role ? (
                    <Badge variant={role === 'admin' ? 'success' : 'muted'}>
                      {role}
                    </Badge>
                  ) : (
                    <span className="text-xs text-faint">—</span>
                  );
                return (
                  <select
                    // Empty value when the role is unknown, so picking ANY role
                    // fires a change event; a preselected option cannot be
                    // assigned by choosing it.
                    value={role}
                    disabled={rolesLoading || roleUpdating}
                    onChange={(e) => onChangeRole?.(u, e.target.value)}
                    className="cursor-pointer rounded-md border border-border bg-input px-2 py-1 text-xs text-body disabled:opacity-50"
                    aria-label={t('users.table.role')}
                  >
                    <option value="" disabled>
                      —
                    </option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                );
              })()}
            </TableCell>
            <TableCell>
              {(() => {
                const status = onboardingByUser?.get(u.id)?.status;
                if (status === 'COMPLETED')
                  return (
                    <Badge variant="success">
                      {t('users.onboarding.sent')}
                    </Badge>
                  );
                if (status === 'RUNNING')
                  return (
                    <Badge variant="muted">
                      {t('users.onboarding.scheduled')}
                    </Badge>
                  );
                return <span className="text-xs text-faint">—</span>;
              })()}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setConfirmId(null);
                    onEdit(u);
                  }}
                >
                  {t('common.edit')}
                </Button>
                {onFindSimilar && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onFindSimilar(u)}
                    title={t('users.table.findSimilarTitle')}
                  >
                    {t('users.table.similar')}
                  </Button>
                )}
                {confirmId === u.id ? (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(u)}
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setConfirmId(null)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    onClick={() => handleDelete(u)}
                  >
                    {t('common.delete')}
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
