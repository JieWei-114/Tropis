import { ANALYTICS_EVENT_TYPES } from '@tropis/shared';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { MinutelyStat } from '../../../lib/api';

const COLORS: Record<string, string> = {
  [ANALYTICS_EVENT_TYPES.PAGE_VIEW]: '#6366f1',
  [ANALYTICS_EVENT_TYPES.BUTTON_CLICK]: '#22c55e',
  [ANALYTICS_EVENT_TYPES.API_CALL]: '#f59e0b',
  [ANALYTICS_EVENT_TYPES.ERROR]: '#ef4444',
  [ANALYTICS_EVENT_TYPES.PURCHASE]: '#14b8a6',
};

interface Props {
  data: MinutelyStat[];
}

interface ChartRow {
  time: string;
  [eventType: string]: number | string;
}

export function MinutelyChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-xl border border-border bg-card p-5 text-[13px] text-faint max-md:p-3.5">
        No minutely data yet — fire some events and wait 1 min for the
        ClickHouse materialized view to populate
      </div>
    );
  }

  // Pivot: group by window, one column per event type
  const byWindow = new Map<number, ChartRow>();
  const eventTypes = new Set<string>();

  for (const row of data) {
    eventTypes.add(row.eventType);
    if (!byWindow.has(row.windowMs)) {
      const d = new Date(row.windowMs);
      byWindow.set(row.windowMs, {
        time: `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
      });
    }
    byWindow.get(row.windowMs)![row.eventType] = row.count;
  }

  const chartData = [...byWindow.values()];

  return (
    <div className="rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        Events per Minute — last hour (ClickHouse materialized view)
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
          <XAxis dataKey="time" tick={{ fill: '#a0a0b8', fontSize: 11 }} />
          <YAxis
            tick={{ fill: '#a0a0b8', fontSize: 11 }}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              background: '#1a1a2e',
              border: '1px solid #2a2a3a',
              borderRadius: 8,
            }}
            labelStyle={{ color: '#e0e0f0' }}
            itemStyle={{ color: '#a0a0b8' }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: '#a0a0b8' }} />
          {[...eventTypes].map((et) => (
            <Line
              key={et}
              type="monotone"
              dataKey={et}
              stroke={COLORS[et] ?? '#6366f1'}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
