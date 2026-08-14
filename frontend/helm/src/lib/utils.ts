import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * shadcn/ui `cn` helper — merges conditional class names and resolves
 * Tailwind conflicts (last one wins). Lives in lib/ (leaf layer): it only
 * depends on external packages, so the dependency-cruiser rules hold.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
