import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Button, restyled onto the app's design tokens: rounded-[7px],
 * 13px text and an opacity-based hover, so every button in the app matches
 * whether or not it goes through this component.
 */
const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-ring/40 enabled:hover:opacity-85 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-transparent bg-primary text-primary-foreground',
        secondary: 'border border-edge/60 bg-raised text-soft',
        outline: 'border border-edge bg-transparent text-soft',
        destructive: 'border border-transparent bg-danger text-white',
        'destructive-outline':
          'border border-danger/60 bg-transparent text-danger',
        ghost:
          'border border-transparent bg-transparent text-muted transition-colors hover:bg-raised hover:text-heading hover:opacity-100',
      },
      size: {
        default: 'rounded-[7px] px-4 py-[7px] text-[13px]',
        sm: 'rounded-[5px] px-2.5 py-1 text-xs',
        icon: 'size-8 rounded-md text-base',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
