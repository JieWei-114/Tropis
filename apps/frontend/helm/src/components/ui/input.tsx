import * as React from 'react';

import { cn } from '@/lib/utils';

/** shadcn/ui Input, restyled onto the app's design tokens. */
const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        'w-full rounded-[7px] border border-border bg-input px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-faint focus:border-primary disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = 'Input';

export { Input };
