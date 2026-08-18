/**
 * STACK FEATURE — health summary pill + per-service status tiles.
 */
import { useTranslation } from 'react-i18next';
import { SERVICE_ORDER, type ServiceState } from '../hooks/useStackHealth';

const SERVICE_META: Record<
  string,
  { label: string; icon: string; desc: string }
> = {
  mongo: { label: 'MongoDB', icon: '🍃', desc: 'Document store' },
  redis: { label: 'Redis', icon: '🔴', desc: 'Cache + BullMQ' },
  postgres: { label: 'PostgreSQL', icon: '🐘', desc: 'Relational + pgvector' },
  elasticsearch: {
    label: 'Elasticsearch',
    icon: '🔍',
    desc: 'Full-text search',
  },
  clickhouse: { label: 'ClickHouse', icon: '📊', desc: 'OLAP analytics' },
  pulsar: { label: 'Pulsar', icon: '📨', desc: 'Event streaming' },
};

export function ServiceHealthCards({ services }: { services: ServiceState[] }) {
  const { t } = useTranslation();
  const upCount = services.filter((s) => s.status === 'up').length;
  const downCount = services.filter((s) => s.status === 'down').length;

  return (
    <>
      {/* ── Health summary bar ── */}
      <div className="flex items-center gap-3">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[13px] font-semibold ${
            upCount === SERVICE_ORDER.length
              ? 'border-success/25 bg-success/10 text-success'
              : downCount === SERVICE_ORDER.length
                ? 'border-danger/25 bg-danger/10 text-danger'
                : 'border-warning/25 bg-warning/10 text-warning'
          }`}
        >
          {upCount === SERVICE_ORDER.length
            ? t('stack.allOperational')
            : t('stack.upDown', { up: upCount, down: downCount })}
        </span>
      </div>

      {/* ── Service tiles ── */}
      <div className="grid grid-cols-3 gap-3 max-[480px]:grid-cols-1 max-md:grid-cols-2">
        {services.map((svc) => {
          const meta = SERVICE_META[svc.name];
          return (
            <div
              key={svc.name}
              className={`flex items-center gap-3 rounded-[10px] border bg-card px-4 py-3.5 transition-colors ${
                svc.status === 'up'
                  ? 'border-success/20'
                  : svc.status === 'down'
                    ? 'border-danger/20'
                    : 'border-border'
              }`}
            >
              <span className="shrink-0 text-[22px]">{meta.icon}</span>
              <div className="flex flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-semibold text-foreground">
                  {meta.label}
                </span>
                <span className="text-[11px] text-muted">{meta.desc}</span>
              </div>
              <span
                className={`h-[9px] w-[9px] shrink-0 rounded-full ${
                  svc.status === 'up'
                    ? 'bg-success shadow-[0_0_6px_#22c55e88]'
                    : svc.status === 'down'
                      ? 'bg-danger'
                      : 'animate-blink-fast bg-warning'
                }`}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
