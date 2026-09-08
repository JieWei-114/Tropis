import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useStackHealth, SystemMap, TechStack } from '../features/stack';
import { useOnboardingWorkflows } from '../features/workflows';

export function StackPage() {
  const { t } = useTranslation();
  const { services, lastChecked, checking, checkHealth } = useStackHealth();
  const { data: onboarding } = useOnboardingWorkflows();

  // Prove Temporal is actually doing work, right on its Stack row.
  const notes: Record<string, string> = {};
  if (onboarding.available) {
    const { running, completed } = onboarding.summary;
    notes.Temporal = `${running} running · ${completed} done`;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-7 px-8 py-8 max-md:px-4">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold tracking-[-0.4px] text-heading">
            {t('stack.title')}
          </h1>
          <p className="text-[13px] text-muted">{t('stack.subtitle')}</p>
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

      <SystemMap services={services} notes={notes} />
      <TechStack />
    </div>
  );
}
