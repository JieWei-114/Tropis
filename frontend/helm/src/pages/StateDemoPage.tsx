/**
 * STATE MANAGEMENT DEMO
 *
 * Shows the same "user list" data fetched and managed 3 ways, side-by-side:
 *
 *   1. Local State   — useState + useEffect. Simple, self-contained, no sharing.
 *   2. Zustand       — Global store with actions. Shared across tabs, persisted in memory.
 *   3. TanStack Query — Server-state cache. Deduplication, background refetch, optimistic updates.
 */

import { useState, useEffect } from 'react';

// ── Local State hook ──────────────────────────────────────────────────────────
import { useUsersLocal } from '../state/local/useUsersLocal';
import { useAnalyticsLocal } from '../state/local/useAnalyticsLocal';

// ── Zustand stores ────────────────────────────────────────────────────────────
import { useUserStore } from '../state/zustand/userStore';
import { useAnalyticsStore } from '../state/zustand/analyticsStore';

// ── TanStack Query hooks ──────────────────────────────────────────────────────
import { useUsers } from '../state/tanstack/useUsersQuery';
import { useAnalyticsStats } from '../state/tanstack/useAnalyticsQuery';

// ── Types ─────────────────────────────────────────────────────────────────────
interface User {
  id: string;
  name: string;
  email: string;
  status: string;
  loginCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-panels
// ─────────────────────────────────────────────────────────────────────────────

function LocalPanel() {
  const { users, loading, error, refetch: reload } = useUsersLocal();
  const { stats, loading: sLoading } = useAnalyticsLocal();

  return (
    <div className="flex flex-col gap-3.5 rounded-[14px] border border-border bg-surface p-5">
      <div className="flex items-center gap-2.5 border-b border-border pb-3.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#3b7a57] text-xs font-bold text-[#a8f0c0]">
          1
        </span>
        <span className="text-[15px] font-bold text-foreground">
          Local State
        </span>
        <code className="ml-auto rounded-md bg-raised px-2 py-[3px] text-[11px] text-primary">
          useState + useEffect
        </code>
      </div>

      <div className="flex flex-col gap-1">
        <Annotation icon="✅" text="Simple — no extra libraries" />
        <Annotation icon="✅" text="Great for component-local data" />
        <Annotation icon="⚠️" text="Two components = two fetch calls" />
        <Annotation icon="⚠️" text="State lost on unmount" />
        <Annotation icon="❌" text="No background refetch / dedup" />
      </div>

      <div className="flex flex-wrap gap-2">
        <StatBadge
          label="Total events"
          value={sLoading ? '…' : String(stats?.totalEvents ?? 0)}
          color="local"
        />
        <StatBadge
          label="Users loaded"
          value={loading ? '…' : String(users.length)}
          color="local"
        />
      </div>

      {error && (
        <p className="rounded-md bg-[#3a0f0f] px-2.5 py-1.5 text-xs text-[#ef5a5a]">
          {error}
        </p>
      )}

      <UserMiniList users={users} loading={loading} />

      <button
        className="cursor-pointer rounded-lg border-none bg-[#1a4a30] px-3 py-[7px] text-xs font-medium text-[#a8f0c0] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => {
          void reload();
        }}
        disabled={loading}
      >
        {loading ? 'Fetching…' : '↺ Re-fetch (new HTTP call)'}
      </button>

      <div className="flex flex-col gap-0.5 rounded-lg border border-border-soft bg-[#0a0a14] px-3 py-2.5">
        <CodeLine>{`const [users, setUsers] = useState<User[]>([])`}</CodeLine>
        <CodeLine>{`useEffect(() => { fetchUsers().then(setUsers) }, [])`}</CodeLine>
        <CodeLine muted>{`// Every render of this component`}</CodeLine>
        <CodeLine muted>{`// triggers its own network request`}</CodeLine>
      </div>
    </div>
  );
}

function ZustandPanel() {
  const users = useUserStore((s) => s.users);
  const loading = useUserStore((s) => s.loading);
  const error = useUserStore((s) => s.error);
  const fetchAll = useUserStore((s) => s.fetchAll);
  const reset = useUserStore((s) => s.reset);

  const total = useAnalyticsStore((s) => s.stats?.totalEvents ?? 0);
  const sLoading = useAnalyticsStore((s) => s.loading);
  const fetchStats = useAnalyticsStore((s) => s.fetchAll);

  // Auto-load on mount — respects the 30s cache so navigating back doesn't re-fetch
  useEffect(() => {
    void fetchAll();
    void fetchStats();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-3.5 rounded-[14px] border border-border bg-surface p-5">
      <div className="flex items-center gap-2.5 border-b border-border pb-3.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#6b3fa0] text-xs font-bold text-[#d4a8f0]">
          2
        </span>
        <span className="text-[15px] font-bold text-foreground">Zustand</span>
        <code className="ml-auto rounded-md bg-raised px-2 py-[3px] text-[11px] text-primary">
          Global store
        </code>
      </div>

      <div className="flex flex-col gap-1">
        <Annotation icon="✅" text="One store shared across all components" />
        <Annotation icon="✅" text="Actions co-located with state" />
        <Annotation icon="✅" text="30s client-side cache built in" />
        <Annotation icon="✅" text="DevTools support (Redux DevTools)" />
        <Annotation icon="⚠️" text="Manual cache invalidation" />
      </div>

      <div className="flex flex-wrap gap-2">
        <StatBadge
          label="Total events"
          value={sLoading ? '…' : String(total)}
          color="zustand"
        />
        <StatBadge
          label="Users in store"
          value={loading ? '…' : String(users.length)}
          color="zustand"
        />
      </div>

      {error && (
        <p className="rounded-md bg-[#3a0f0f] px-2.5 py-1.5 text-xs text-[#ef5a5a]">
          {error}
        </p>
      )}

      <UserMiniList users={users} loading={loading} />

      <div className="flex flex-wrap gap-1.5">
        <button
          className="cursor-pointer rounded-lg border-none bg-[#2e1a4a] px-3 py-[7px] text-xs font-medium text-[#d4a8f0] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            void fetchAll();
          }}
          disabled={loading}
        >
          {loading ? 'Fetching…' : '↺ fetchAll() (cached 30s)'}
        </button>
        <button
          className="cursor-pointer rounded-lg border-none bg-raised px-3 py-[7px] text-xs font-medium text-muted transition-opacity hover:text-body disabled:cursor-not-allowed disabled:opacity-40"
          onClick={reset}
        >
          ✕ reset
        </button>
        <button
          className="cursor-pointer rounded-lg border-none bg-raised px-3 py-[7px] text-xs font-medium text-muted transition-opacity hover:text-body disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            void fetchStats();
          }}
          disabled={sLoading}
        >
          ↺ stats
        </button>
      </div>

      <div className="flex flex-col gap-0.5 rounded-lg border border-border-soft bg-[#0a0a14] px-3 py-2.5">
        <CodeLine>{`const users = useUserStore(s => s.users)`}</CodeLine>
        <CodeLine>{`const fetchAll = useUserStore(s => s.fetchAll)`}</CodeLine>
        <CodeLine muted>{`// fetchAll() skips HTTP if lastFetchedAt`}</CodeLine>
        <CodeLine muted>{`// is within 30s — no duplicate calls`}</CodeLine>
      </div>
    </div>
  );
}

function TanStackPanel() {
  const {
    data: usersRaw = [],
    isLoading,
    isFetching,
    dataUpdatedAt,
  } = useUsers();
  const users = usersRaw as User[];
  const { data: stats, isLoading: sLoading } = useAnalyticsStats();

  const age = dataUpdatedAt
    ? Math.round((Date.now() - dataUpdatedAt) / 1000)
    : null;

  return (
    <div className="flex flex-col gap-3.5 rounded-[14px] border border-border bg-surface p-5">
      <div className="flex items-center gap-2.5 border-b border-border pb-3.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#9b4a20] text-xs font-bold text-[#f0c8a8]">
          3
        </span>
        <span className="text-[15px] font-bold text-foreground">
          TanStack Query
        </span>
        <code className="ml-auto rounded-md bg-raised px-2 py-[3px] text-[11px] text-primary">
          useQuery + cache
        </code>
      </div>

      <div className="flex flex-col gap-1">
        <Annotation
          icon="✅"
          text="Automatic deduplication — one request for N components"
        />
        <Annotation icon="✅" text="Background refetch on window focus" />
        <Annotation icon="✅" text="staleTime = 30s; gcTime = 5min" />
        <Annotation icon="✅" text="Optimistic updates + rollback built-in" />
        <Annotation icon="✅" text="Loading / error / stale states for free" />
      </div>

      <div className="flex flex-wrap gap-2">
        <StatBadge
          label="Total events"
          value={sLoading ? '…' : String(stats?.totalEvents ?? 0)}
          color="tanstack"
        />
        <StatBadge
          label="Users cached"
          value={isLoading ? '…' : String(users.length)}
          color="tanstack"
        />
        {age !== null && (
          <StatBadge label="Cache age" value={`${age}s`} color="tanstack" />
        )}
      </div>

      {isFetching && !isLoading && (
        <p className="m-0 text-[11px] text-[#f0c87a]">
          ↻ Background refetch in progress…
        </p>
      )}

      <UserMiniList users={users} loading={isLoading} />

      <div className="flex flex-col gap-0.5 rounded-lg border border-border-soft bg-[#0a0a14] px-3 py-2.5">
        <CodeLine>{`const { data, isLoading, isFetching }`}</CodeLine>
        <CodeLine>{`  = useQuery({ queryKey: ['users','list'],`}</CodeLine>
        <CodeLine>{`    queryFn: fetchUsers, staleTime: 30_000 })`}</CodeLine>
        <CodeLine muted>{`// Any component calling this shares`}</CodeLine>
        <CodeLine muted>{`// ONE cached response automatically`}</CodeLine>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison table
// ─────────────────────────────────────────────────────────────────────────────

function ComparisonTable() {
  const rows = [
    {
      feature: 'Sharing across components',
      local: '❌ Re-fetch each',
      zustand: '✅ Single store',
      tanstack: '✅ Shared cache',
    },
    {
      feature: 'Background refetch',
      local: '❌ Manual',
      zustand: '❌ Manual',
      tanstack: '✅ Auto on focus',
    },
    {
      feature: 'Deduplication',
      local: '❌ None',
      zustand: '⚠️ 30s manual',
      tanstack: '✅ Automatic',
    },
    {
      feature: 'Optimistic updates',
      local: '⚠️ DIY',
      zustand: '⚠️ DIY',
      tanstack: '✅ Built-in',
    },
    {
      feature: 'DevTools',
      local: 'React DevTools',
      zustand: 'Redux DevTools',
      tanstack: 'TanStack DevTools',
    },
    {
      feature: 'Server mutation handling',
      local: '⚠️ Manual re-fetch',
      zustand: '⚠️ Manual invalidate',
      tanstack: '✅ invalidateQueries',
    },
    {
      feature: 'Best for',
      local: 'UI state, forms',
      zustand: 'Auth, UI globals',
      tanstack: 'Any server data',
    },
  ];

  return (
    <div className="overflow-x-auto rounded-[14px] border border-border bg-surface p-5 max-md:max-w-full">
      <h3 className="mt-0 mb-3.5 text-sm font-bold tracking-[0.6px] text-muted uppercase">
        Comparison
      </h3>
      <table className="w-full border-collapse text-[13px] max-md:min-w-[560px] [&_td]:border-b [&_td]:border-border-soft [&_td]:px-3.5 [&_td]:py-[9px] [&_td]:text-left [&_td]:text-[#b0b0d0] [&_tr:last-child>td]:border-b-0">
        <thead>
          <tr>
            <th className="border-b border-border-soft px-3.5 py-[9px] text-left text-[11px] font-semibold tracking-[0.5px] text-muted uppercase">
              Feature
            </th>
            <th className="border-b border-border-soft px-3.5 py-[9px] text-left text-[11px] font-semibold tracking-[0.5px] text-[#5aef9a] uppercase">
              Local State
            </th>
            <th className="border-b border-border-soft px-3.5 py-[9px] text-left text-[11px] font-semibold tracking-[0.5px] text-[#d4a8f0] uppercase">
              Zustand
            </th>
            <th className="border-b border-border-soft px-3.5 py-[9px] text-left text-[11px] font-semibold tracking-[0.5px] text-[#f0c8a8] uppercase">
              TanStack Query
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.feature}>
              <td className="font-medium !text-foreground">{r.feature}</td>
              <td>{r.local}</td>
              <td>{r.zustand}</td>
              <td>{r.tanstack}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MINI_STATUS: Record<string, string> = {
  active: 'bg-[#0f3a20] text-[#5aef9a]',
  inactive: 'bg-[#2a1a0f] text-[#ef9a5a]',
  suspended: 'bg-[#3a0f0f] text-[#ef5a5a]',
};

function UserMiniList({ users, loading }: { users: User[]; loading: boolean }) {
  if (loading)
    return (
      <div className="flex min-h-[110px] items-center justify-center rounded-lg border border-dashed border-border text-[13px] text-[#505070]/50">
        Loading users…
      </div>
    );
  if (!users.length)
    return (
      <div className="flex min-h-[110px] items-center justify-center rounded-lg border border-dashed border-border text-[13px] text-[#505070]/50">
        No users — fetch first
      </div>
    );
  return (
    <ul className="m-0 flex min-h-[110px] list-none flex-col gap-1 p-0">
      {users.slice(0, 5).map((u) => (
        <li
          key={u.id}
          className="flex items-center gap-2 rounded-md bg-[#0d0d1a] px-2 py-[5px]"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-bold text-soft">
            {u.name[0]?.toUpperCase()}
          </span>
          <span className="flex-1 truncate text-xs text-body">{u.name}</span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] capitalize ${
              MINI_STATUS[u.status] ?? 'bg-raised text-muted'
            }`}
          >
            {u.status}
          </span>
        </li>
      ))}
      {users.length > 5 && (
        <li className="px-2 py-1 text-[11px] text-[#505080]/50">
          +{users.length - 5} more
        </li>
      )}
    </ul>
  );
}

const STAT_COLORS: Record<string, string> = {
  local: 'border-[#1a4a30] bg-[#0f2a1f]',
  zustand: 'border-[#2e1a4a] bg-[#1a0f2e]',
  tanstack: 'border-[#4a2e1a] bg-[#2e1a0f]',
};

function StatBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      className={`flex min-w-[72px] flex-col items-center rounded-lg border px-3 py-2 ${STAT_COLORS[color] ?? ''}`}
    >
      <span className="text-xl font-bold text-foreground">{value}</span>
      <span className="text-center text-[10px] text-muted">{label}</span>
    </div>
  );
}

function Annotation({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex gap-2 text-xs text-muted [&>span:first-child]:shrink-0">
      <span>{icon}</span>
      <span>{text}</span>
    </div>
  );
}

function CodeLine({ children, muted }: { children: string; muted?: boolean }) {
  return (
    <div
      className={`font-mono text-[11px] whitespace-pre ${muted ? 'text-[#404060]' : 'text-[#a0c0e0]'}`}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export function StateDemoPage() {
  const [active, setActive] = useState<'all' | '1' | '2' | '3'>('all');

  return (
    <div className="flex flex-col gap-8 pb-12">
      <div className="flex flex-col gap-2.5">
        <h2 className="m-0 text-[22px] font-bold text-foreground">
          State Management Patterns
        </h2>
        <p className="m-0 max-w-[700px] text-sm text-muted">
          The same user list and analytics stats — fetched 3 ways. Each panel is
          fully independent so you can observe the differences live.
        </p>

        <div className="flex flex-wrap gap-2">
          {(['all', '1', '2', '3'] as const).map((v) => (
            <button
              key={v}
              className={`cursor-pointer rounded-[20px] border px-3.5 py-1.5 text-[13px] transition-colors ${
                active === v
                  ? 'border-primary bg-primary/15 text-primary-soft'
                  : 'border-border bg-surface text-muted hover:border-primary/40 hover:text-body'
              }`}
              onClick={() => setActive(v)}
            >
              {v === 'all'
                ? 'All 3'
                : v === '1'
                  ? 'Local'
                  : v === '2'
                    ? 'Zustand'
                    : 'TanStack'}
            </button>
          ))}
        </div>
      </div>

      <div
        className={`grid items-start gap-5 ${
          active !== 'all'
            ? 'max-w-[480px] grid-cols-1'
            : 'grid-cols-3 max-[960px]:grid-cols-1'
        }`}
      >
        {(active === 'all' || active === '1') && <LocalPanel />}
        {(active === 'all' || active === '2') && <ZustandPanel />}
        {(active === 'all' || active === '3') && <TanStackPanel />}
      </div>

      <ComparisonTable />
    </div>
  );
}
