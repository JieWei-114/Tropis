import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/** shadcn/ui Badge on app tokens — pill shape matching the old status/WS badges. */
const badgeVariants = cva(
  'inline-flex items-center gap-[5px] rounded-full border px-[9px] py-0.5 text-[11px] font-semibold tracking-[0.3px]',
  {
    variants: {
      variant: {
        default: 'border-primary/25 bg-primary/10 text-primary-soft',
        success: 'border-success/25 bg-success/10 text-success',
        warning: 'border-warning/25 bg-warning/10 text-warning',
        destructive: 'border-danger/25 bg-danger/10 text-danger',
        muted: 'border-border bg-surface text-muted',
        outline: 'border-border bg-card text-muted',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { Badge, badgeVariants };
