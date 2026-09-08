import { useTranslation } from 'react-i18next';
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
import { eventColor } from '../eventColors';

interface Props {
  data: EventTypeStat[];
}

export function EventChart({ data }: Props) {
  const { t } = useTranslation();
  if (data.length === 0) {
    return (
      <div className="flex h-[120px] items-center justify-center rounded-xl border border-border bg-card p-5 text-[13px] text-faint max-md:p-3.5">
        {t('analytics.eventChartEmpty')}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 max-md:p-3.5">
      <h3 className="mb-4 text-sm font-semibold text-body">
        {t('analytics.eventsByType')}
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart
          data={data}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" />
          <XAxis
            dataKey="eventType"
            tick={{ fill: 'var(--muted)', fontSize: 12 }}
          />
          <YAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <Tooltip
            cursor={{ fill: 'var(--surface)' }}
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
            labelStyle={{ color: 'var(--heading)' }}
            itemStyle={{ color: 'var(--muted)' }}
          />
          <Bar dataKey="count" radius={[6, 6, 0, 0]}>
            {data.map((entry) => (
              <Cell key={entry.eventType} fill={eventColor(entry.eventType)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
