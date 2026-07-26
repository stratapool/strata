import { useEffect, useState } from 'react';

/**
 * Eases a number up from zero when a screen is entered.
 *
 * Returns `value * progress` rather than tracking its own copy of the number.
 * That keeps it purely presentational: once the intro finishes progress is
 * pinned at 1, so a pool that grows while you are looking at it updates
 * immediately instead of appearing frozen behind a stale animation.
 */
export function useCountUp(value: number, durationMs = 1300, key: unknown = 0): number {
  const [progress, setProgress] = useState(1);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setProgress(1);
      return;
    }
    setProgress(0);
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / durationMs);
      setProgress(1 - Math.pow(1 - k, 3));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // requestAnimationFrame does not fire in a hidden tab or an embedded view
    // that never composites. Without this the number would sit at zero
    // indefinitely — reporting an empty anonymity set for a pool that is not
    // empty, which is precisely the kind of wrong figure this UI must not show.
    const failsafe = setTimeout(() => setProgress(1), durationMs + 400);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(failsafe);
    };
  }, [key, durationMs]);

  return value * progress;
}
