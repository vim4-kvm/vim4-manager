import type { ReactNode } from "react";
import { AnimatePresence, LazyMotion, m, useReducedMotion } from "motion/react";
import { enter, exit, layoutSpring } from "@/lib/motion";

// Layout animation lives in domMax; load it only where a list needs it.
const layoutFeatures = () => import("@/lib/motion-features").then((module) => module.default);

/** List whose items enter, leave and reorder smoothly (keyed by `getKey`). */
export function AnimatedList<T>({ items, getKey, children, className, itemClassName, label }: {
  items: T[];
  getKey: (item: T) => string;
  children: (item: T) => ReactNode;
  className?: string;
  itemClassName?: string;
  label?: string;
}) {
  const reduced = useReducedMotion();
  if (reduced) {
    return <ul aria-label={label} className={className}>{items.map((item) => <li key={getKey(item)} className={itemClassName}>{children(item)}</li>)}</ul>;
  }
  return (
    <LazyMotion features={layoutFeatures}>
      <ul aria-label={label} className={className}>
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <m.li
              key={getKey(item)}
              layout
              className={itemClassName}
              transition={{ layout: layoutSpring }}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1, transition: enter() }}
              exit={{ opacity: 0, scale: 0.98, transition: exit() }}
            >
              {children(item)}
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
    </LazyMotion>
  );
}
