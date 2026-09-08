import { useTranslation } from 'react-i18next';
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
import { eventColor } from '../eventColors';

interface Props {
  data: MinutelyStat[];
}

interface ChartRow {
  time: string;
  [eventType: string]: number | string;
}

export function MinutelyChart({ data }: Props) {
  const { t } = useTranslation();
  if (data.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-xl border border-border bg-card p-5 text-[13px] text-faint max-md:p-3.5">
        {t('analytics.minutelyEmpty')}
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
        {t('analytics.eventsPerMinute')}
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart
          data={chartData}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" />
          <XAxis dataKey="time" tick={{ fill: 'var(--muted)', fontSize: 11 }} />
          <YAxis
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ stroke: 'var(--edge)' }}
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
            labelStyle={{ color: 'var(--heading)' }}
            itemStyle={{ color: 'var(--muted)' }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted)' }} />
          {[...eventTypes].map((et) => (
            <Line
              key={et}
              type="monotone"
              dataKey={et}
              stroke={eventColor(et)}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
