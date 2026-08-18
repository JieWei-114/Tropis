import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { z } from 'zod';
import type {
  User,
  CreateUserPayload,
  ReplaceUserPayload,
} from '../../../lib/api';
import { parseApiError } from '../../../lib/error';
import { useZodForm, optionalAgeString } from '../../../lib/forms';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  user: User | null; // null = create mode, User = edit mode
  onClose: () => void;
  onSave: (
    data: CreateUserPayload | ReplaceUserPayload,
    method: 'POST' | 'PUT',
  ) => Promise<void>;
}

/** Create requires a password; edit accepts blank = "keep current". */
function makeSchema(isEdit: boolean, t: TFunction) {
  return z.object({
    name: z.string().min(1, t('users.validation.nameRequired')),
    email: z.string().email(t('users.validation.emailInvalid')),
    password: isEdit
      ? z
          .string()
          .refine(
            (v) => v === '' || v.length >= 8,
            t('users.validation.passwordMin8'),
          )
      : z.string().min(8, t('users.validation.passwordMin8')),
    age: optionalAgeString(t('users.validation.ageRange')),
    status: z.enum(['active', 'inactive']),
  });
}

type FormValues = z.infer<ReturnType<typeof makeSchema>>;

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-danger">
      {message}
    </p>
  );
}

export function UserModal({ user, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const isEdit = user !== null;
  const [error, setError] = useState('');

  const schema = useMemo(() => makeSchema(isEdit, t), [isEdit, t]);
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useZodForm(schema, {
    defaultValues: {
      name: user?.name ?? '',
      email: user?.email ?? '',
      password: '',
      age: user?.age?.toString() ?? '',
      status: user?.status ?? 'active',
    },
  });
  const status = watch('status');

  const onSubmit = async ({
    name,
    email,
    password,
    age,
    status,
  }: FormValues) => {
    setError('');
    try {
      if (isEdit) {
        // PUT — send all required fields
        const body: ReplaceUserPayload = {
          name,
          email,
          status,
          ...(age ? { age: Number(age) } : {}),
          ...(password ? { password } : {}),
        };
        await onSave(body, 'PUT');
      } else {
        // POST — password required
        const body: CreateUserPayload = {
          name,
          email,
          password,
          ...(age ? { age: Number(age) } : {}),
        };
        await onSave(body, 'POST');
      }
      onClose();
    } catch (err) {
      setError(parseApiError(err).message);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* `.modal` class hook kept for the e2e suite */}
      <DialogContent
        className="modal"
        {...(isEdit ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('users.modal.editTitle') : t('users.modal.newTitle')}
          </DialogTitle>
        </DialogHeader>

        {isEdit && (
          <DialogDescription className="border-b border-border bg-primary/10 px-5 py-2 text-primary-soft">
            <Trans
              i18nKey="users.modal.putNote"
              values={{ id: user.id }}
              components={{ strong: <strong /> }}
            />
          </DialogDescription>
        )}

        <form
          className="flex flex-col gap-4 p-5"
          noValidate
          onSubmit={(e) => {
            void handleSubmit(onSubmit)(e);
          }}
        >
          {error && (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}

          <div className="flex gap-3.5">
            <div className="flex flex-1 flex-col gap-[5px]">
              <Label htmlFor="user-name">{t('users.modal.name')}</Label>
              <Input
                id="user-name"
                data-testid="user-name"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? 'user-name-error' : undefined}
                {...register('name')}
              />
              <FieldError id="user-name-error" message={errors.name?.message} />
            </div>
            <div className="flex flex-1 flex-col gap-[5px]">
              <Label htmlFor="user-email">{t('users.modal.email')}</Label>
              <Input
                id="user-email"
                data-testid="user-email"
                type="email"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? 'user-email-error' : undefined}
                {...register('email')}
              />
              <FieldError
                id="user-email-error"
                message={errors.email?.message}
              />
            </div>
          </div>

          <div className="flex gap-3.5">
            <div className="flex flex-1 flex-col gap-[5px]">
              <Label htmlFor="user-password">
                {isEdit
                  ? t('users.modal.passwordKeep')
                  : t('users.modal.password')}
              </Label>
              <Input
                id="user-password"
                data-testid="user-password"
                type="password"
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={
                  errors.password ? 'user-password-error' : undefined
                }
                {...register('password')}
              />
              <FieldError
                id="user-password-error"
                message={errors.password?.message}
              />
            </div>
            <div className="flex flex-1 flex-col gap-[5px]">
              <Label htmlFor="user-age">{t('users.modal.age')}</Label>
              <Input
                id="user-age"
                data-testid="user-age"
                type="number"
                min={0}
                max={120}
                aria-invalid={errors.age ? true : undefined}
                aria-describedby={errors.age ? 'user-age-error' : undefined}
                {...register('age')}
              />
              <FieldError id="user-age-error" message={errors.age?.message} />
            </div>
          </div>

          {isEdit && (
            <div className="flex flex-1 flex-col gap-[5px]">
              <Label htmlFor="user-status">{t('users.modal.status')}</Label>
              <Select
                value={status}
                onValueChange={(v) =>
                  setValue('status', v as FormValues['status'])
                }
              >
                <SelectTrigger id="user-status" data-testid="user-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">active</SelectItem>
                  <SelectItem value="inactive">inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? t('common.saving')
                : isEdit
                  ? t('users.modal.savePut')
                  : t('users.modal.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
