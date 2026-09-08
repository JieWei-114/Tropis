/**
 * ZUSTAND — Toast Store
 *
 * Global notification queue. Any service/component can push a toast
 * without needing to pass callbacks down the tree.
 *
 * Held in a store rather than local state because the callers are spread
 * across the tree (App.tsx → UsersPage → UserModal → …) and prop-drilling
 * `push` down every one of those levels couples them all to toasting.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export interface Toast {
  id: string;
  type: 'success' | 'info' | 'warning' | 'error';
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let _seq = 0;

export const useToastStore = create<ToastState>()(
  devtools(
    (set) => ({
      toasts: [],

      push: (toast) =>
        set(
          (state) => ({
            toasts: [...state.toasts, { ...toast, id: `t-${++_seq}` }].slice(
              -5,
            ),
          }),
          false,
          'toast/push',
        ),

      dismiss: (id) =>
        set(
          (state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }),
          false,
          'toast/dismiss',
        ),

      clear: () => set({ toasts: [] }, false, 'toast/clear'),
    }),
    { name: 'ToastStore' },
  ),
);
