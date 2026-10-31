import type { Transition } from "motion/react";

/** The only motion values used by the app; keep new animations on these tokens. */
export const duration = { fast: 0.15, base: 0.2, slow: 0.28 } as const;
export const ease = {
  enter: [0.22, 1, 0.36, 1] as [number, number, number, number],
  exit: [0.22, 1, 0.36, 1] as [number, number, number, number],
};
export const layoutSpring: Transition = { duration: 0.3, ease: ease.enter };

export const enter = (speed: keyof typeof duration = "base"): Transition => ({ duration: duration[speed], ease: ease.enter });
export const exit = (speed: keyof typeof duration = "fast"): Transition => ({ duration: duration[speed], ease: ease.exit });
