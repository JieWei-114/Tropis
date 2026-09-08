import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { z } from 'zod';
import { login, createUser, getToken } from '../../../lib/api';
import { tracker } from '../../../lib/tracking';
import { useZodForm, optionalAgeString } from '../../../lib/forms';
import { TRACKING_EVENTS } from '@tropis/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  onLogin: (token: string) => void;
}

type Mode = 'login' | 'register';

/**
 * One schema shape for both modes — name is only required in register mode,
 * so the form's value type stays stable when the user switches tabs.
 */
function makeSchema(mode: Mode, t: TFunction) {
  return z.object({
    name:
      mode === 'register'
        ? z.string().min(1, t('auth.validation.nameRequired'))
        : z.string(),
    age: optionalAgeString(t('auth.validation.ageRange')),
    email: z.string().email(t('auth.validation.emailInvalid')),
    password: z.string().min(8, t('auth.validation.passwordMin8')),
  });
}

type FormValues = z.infer<ReturnType<typeof makeSchema>>;

const EMPTY: FormValues = { name: '', age: '', email: '', password: '' };

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-danger">
      {message}
    </p>
  );
}

export function LoginForm({ onLogin }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('login');
  const [error, setError] = useState('');

  const schema = useMemo(() => makeSchema(mode, t), [mode, t]);
  const {
    register,
    handleSubmit,
    reset: resetForm,
    formState: { errors, isSubmitting },
  } = useZodForm(schema, { defaultValues: EMPTY });

  const reset = (next: Mode) => {
    setMode(next);
    setError('');
    resetForm(EMPTY);
  };

  const onSubmit = async ({ name, age, email, password }: FormValues) => {
    setError('');
    try {
      if (mode === 'register') {
        await createUser({
          name,
          email,
          password,
          age: age ? parseInt(age, 10) : undefined,
        });
        tracker.track(TRACKING_EVENTS.USER_REGISTER.name, { email });
        // Auto-login after successful registration
        await login(email, password);
      } else {
        await login(email, password);
      }
      // Tie the anonymous tracking id to the signed-in user
      tracker.identify(email);
      tracker.track(TRACKING_EVENTS.USER_LOGIN.name, { mode });
      onLogin(getToken()!);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.genericError'));
    }
  };

  const tabClass = (active: boolean) =>
    `flex-1 cursor-pointer rounded-md border-none bg-transparent py-[7px] text-[13px] font-medium transition-colors ${
      active ? 'bg-raised text-heading' : 'text-muted hover:text-body'
    }`;

  return (
    <div className="flex min-h-[calc(100dvh-58px)] items-center justify-center px-4 py-10">
      <Card className="w-full max-w-[400px]">
        <form
          className="flex flex-col gap-[18px] px-8 py-9"
          noValidate
          onSubmit={(e) => {
            void handleSubmit(onSubmit)(e);
          }}
        >
          {/* Mode toggle */}
          <div className="flex rounded-lg border border-border bg-input p-[3px]">
            <button
              type="button"
              className={tabClass(mode === 'login')}
              onClick={() => reset('login')}
            >
              {t('auth.signIn')}
            </button>
            <button
              type="button"
              className={tabClass(mode === 'register')}
              onClick={() => reset('register')}
            >
              {t('auth.register')}
            </button>
          </div>

          <p className="text-xs text-muted [&_code]:text-primary-soft">
            {mode === 'login' ? (
              <>
                Auth via <code>gRPC AuthService/Login</code> → Envoy → NestJS
              </>
            ) : (
              <>
                Creates user via <code>gRPC UserService/Create</code>, then
                auto-signs in
              </>
            )}
          </p>

          {error && (
            <p
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
              data-testid="login-error"
            >
              {error}
            </p>
          )}

          {mode === 'register' && (
            <div className="flex gap-3.5">
              <div className="flex flex-1 flex-col gap-[5px]">
                <Label htmlFor="login-name">{t('auth.name')}</Label>
                <Input
                  id="login-name"
                  data-testid="login-name"
                  type="text"
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={
                    errors.name ? 'login-name-error' : undefined
                  }
                  {...register('name')}
                />
                <FieldError
                  id="login-name-error"
                  message={errors.name?.message}
                />
              </div>
              <div className="flex max-w-20 flex-1 flex-col gap-[5px]">
                <Label htmlFor="login-age">{t('auth.age')}</Label>
                <Input
                  id="login-age"
                  data-testid="login-age"
                  type="number"
                  min={1}
                  max={120}
                  aria-invalid={errors.age ? true : undefined}
                  aria-describedby={errors.age ? 'login-age-error' : undefined}
                  {...register('age')}
                />
                <FieldError
                  id="login-age-error"
                  message={errors.age?.message}
                />
              </div>
            </div>
          )}

          <div className="flex flex-1 flex-col gap-[5px]">
            <Label htmlFor="login-email">{t('auth.email')}</Label>
            <Input
              id="login-email"
              data-testid="login-email"
              type="email"
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
              {...register('email')}
            />
            <FieldError
              id="login-email-error"
              message={errors.email?.message}
            />
          </div>

          <div className="flex flex-1 flex-col gap-[5px]">
            <Label htmlFor="login-password">{t('auth.password')}</Label>
            <Input
              id="login-password"
              data-testid="login-password"
              type="password"
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={
                errors.password ? 'login-password-error' : undefined
              }
              {...register('password')}
            />
            <FieldError
              id="login-password-error"
              message={errors.password?.message}
            />
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting
              ? mode === 'register'
                ? t('auth.creatingAccount')
                : t('auth.signingIn')
              : mode === 'register'
                ? t('auth.createAccountAndSignIn')
                : t('auth.signIn')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
