/**
 * Form convention: react-hook-form + zod.
 *
 * Every form defines a zod schema (single source of truth for validation,
 * mirroring the backend's DTO validation) and wires it up through
 * `useZodForm`. Field errors are rendered inline with `aria-invalid` on the
 * input and the error text linked via `aria-describedby`.
 *
 * i18n: validation messages come from react-i18next. Each form builds its
 * schema with the `t` function (`makeSchema(t)` memoized on `[t]`), passing
 * translated message keys (`t('users.validation.…')`) per field — no global
 * zod errorMap, so messages stay co-located with the schema and re-resolve
 * on language change.
 *
 * Reference implementations: features/auth/components/LoginForm.tsx and
 * features/users/components/UserModal.tsx.
 */
import {
  useForm,
  type UseFormProps,
  type FieldValues,
  type Resolver,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

/** `useForm` pre-wired with a zodResolver and sane defaults. */
export function useZodForm<TValues extends FieldValues>(
  schema: z.ZodType<TValues, TValues>,
  props?: Omit<UseFormProps<TValues>, 'resolver'>,
) {
  return useForm<TValues>({
    mode: 'onSubmit',
    reValidateMode: 'onChange',
    ...props,
    resolver: zodResolver(schema) as Resolver<TValues>,
  });
}

/**
 * HTML number inputs yield strings (and clear to ''), so "optional age"
 * is a string field validated here and converted with `Number()` on submit.
 */
export const optionalAgeString = (message: string) =>
  z
    .string()
    .refine(
      (v) =>
        v === '' ||
        (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 120),
      message,
    );
