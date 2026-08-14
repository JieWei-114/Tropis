import { ANALYTICS_EVENT_TYPES } from '@tropis/shared';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import type { EventTypeStat } from '../../../lib/api';

const COLORS: Record<string, string> = {
  [ANALYTICS_EVENT_TYPES.PAGE_VIEW]: '#6366f1',
  [ANALYTICS_EVENT_TYPES.BUTTON_CLICK]: '#22c55e',
  [ANALYTICS_EVENT_TYPES.API_CALL]: '#f59e0b',
  [ANALYTICS_EVENT_TYPES.ERROR]: '#ef4444',
  [ANALYTICS_EVENT_TYPES.PURCHASE]: '#14b8a6',
};

interface Props {
  data: EventTypeStat[];
}

export function EventChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-xl border border-border bg-card p-5 text-[13px] text-faint max-md:p-3.5">
        No ClickHouse data yet — fire some events and wait ~5s
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        Events by Type — last 24h (ClickHouse)
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={data}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
          <XAxis dataKey="eventType" tick={{ fill: '#a0a0b8', fontSize: 12 }} />
          <YAxis tick={{ fill: '#a0a0b8', fontSize: 12 }} />
          <Tooltip
            contentStyle={{
              background: '#1a1a2e',
              border: '1px solid #2a2a3a',
              borderRadius: 8,
            }}
            labelStyle={{ color: '#e0e0f0' }}
            itemStyle={{ color: '#a0a0b8' }}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data.map((entry) => (
              <Cell
                key={entry.eventType}
                fill={COLORS[entry.eventType] ?? '#6366f1'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
