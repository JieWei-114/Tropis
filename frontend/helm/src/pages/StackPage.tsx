import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  useStackHealth,
  ServiceHealthCards,
  VaultCard,
  PatternsCard,
  StackLinks,
} from '../features/stack';

export function StackPage() {
  const { t } = useTranslation();
  const { services, lastChecked, checking, checkHealth } = useStackHealth();

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-7 px-6 py-8">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-heading">{t('stack.title')}</h2>
          <p className="mt-[3px] text-xs text-muted">{t('stack.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lastChecked && (
            <span className="text-xs text-faint">
              {t('stack.lastChecked', {
                time: lastChecked.toLocaleTimeString(),
              })}
            </span>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              void checkHealth();
            }}
            disabled={checking}
          >
            {checking ? t('common.checking') : t('common.refresh')}
          </Button>
        </div>
      </div>

      <ServiceHealthCards services={services} />
      <VaultCard />
      <PatternsCard />
      <StackLinks />
    </div>
  );
}
