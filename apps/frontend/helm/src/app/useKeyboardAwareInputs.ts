import { useEffect } from 'react';

/**
 * Keeps the focused field visible when the soft keyboard opens.
 *
 * A webview does not reliably scroll a focused input above the keyboard: the
 * keyboard shrinks the visual viewport without changing layout, so a field in
 * the lower half of the screen — the login password box, the user modal, the
 * search bar — ends up behind it with no way to see what is being typed.
 *
 * This scrolls the focused element into the middle of the *visible* area,
 * measured from `visualViewport` when the platform provides it. It listens on
 * `focusin` at the document level so it covers every field, including ones
 * mounted later inside a modal.
 *
 * Harmless on desktop: without a keyboard the visual viewport equals the
 * layout viewport, the field is already inside it, and nothing scrolls.
 */
export function useKeyboardAwareInputs(): void {
  useEffect(() => {
    const FIELDS = 'input, textarea, select';
    /** Time for the keyboard animation to settle before measuring. */
    const SETTLE_MS = 250;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.matches?.(FIELDS)) return;

      clearTimeout(timer);
      timer = setTimeout(() => {
        const viewport = window.visualViewport;
        const visibleHeight = viewport?.height ?? window.innerHeight;
        const rect = target.getBoundingClientRect();
        // `visualViewport.offsetTop` is how far the viewport itself has been
        // shifted up; the field's position within the visible area is its
        // viewport-relative top minus that shift.
        const topInVisible = rect.top - (viewport?.offsetTop ?? 0);

        const hiddenBelow = topInVisible + rect.height > visibleHeight;
        const hiddenAbove = topInVisible < 0;
        if (hiddenBelow || hiddenAbove) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, SETTLE_MS);
    };

    document.addEventListener('focusin', onFocusIn);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);
}
