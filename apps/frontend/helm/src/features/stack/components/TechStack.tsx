import { useTranslation } from 'react-i18next';
/**
 * STACK FEATURE — "Built with": the frameworks, libraries, and languages the
 * app is built on. Unlike the service list, these have no status or console —
 * they're the tech the code itself uses.
 */
const GROUPS: { label: string; items: string[] }[] = [
  { label: 'Languages', items: ['TypeScript', 'Rust', 'Java'] },
  {
    label: 'Backend',
    items: [
      'NestJS',
      'gRPC',
      'Protobuf (buf)',
      'BullMQ',
      'Socket.io',
      'OpenTelemetry',
      'Pino',
      'Passport (OAuth)',
      'CQRS',
    ],
  },
  {
    label: 'Frontend',
    items: [
      'React',
      'Next.js',
      'Vite',
      'TanStack Query',
      'Zustand',
      'Tailwind CSS',
      'i18next',
      'Tauri',
    ],
  },
  { label: 'Platform', items: ['Docker', 'Kubernetes', 'Helm', 'Argo CD'] },
];

export function TechStack() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card/40 p-5">
      <h3 className="text-sm font-semibold text-heading">
        {t('stack.builtWith')}
      </h3>
      {GROUPS.map((g) => (
        <div
          key={g.label}
          className="grid grid-cols-[110px_1fr] gap-4 max-md:grid-cols-1 max-md:gap-1.5"
        >
          <span className="pt-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
            {g.label}
          </span>
          <div className="flex flex-wrap gap-2">
            {g.items.map((i) => (
              <span
                key={i}
                className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-body"
              >
                {i}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
