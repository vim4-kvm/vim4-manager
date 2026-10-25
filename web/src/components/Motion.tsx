import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { enter, exit } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Only a changed text identity fades out and in; repeated polls stay still.
 */
export function FadeText({ id, children, className }: { id: string; children?: ReactNode; className?: string }) {
  const mounted = useRef(false);
  const reduced = useReducedMotion();
  useEffect(() => { mounted.current = true; }, []);
  if (reduced) return <span className={className}>{children ?? id}</span>;
  return (
    <AnimatePresence mode="wait" initial={false}><m.span key={id} className={className}
      initial={mounted.current ? { opacity: 0 } : false} animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: exit("fast") }} transition={enter("fast")}>
      {children ?? id}
    </m.span></AnimatePresence>
  );
}

/** Height and opacity reveal for conditional sections; never animates first paint. */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return open ? <div className={className}>{children}</div> : null;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          key="collapse"
          className={cn("overflow-hidden", className)}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1, transition: enter() }}
          exit={{ height: 0, opacity: 0, transition: exit() }}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}

/** Skeleton-to-content handoff: content fades in once when it replaces a placeholder. */
export function FadeIn({ children, className, ...data }: { children: ReactNode; className?: string } & { [key: `data-${string}`]: string | boolean | undefined }) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className} {...data}>{children}</div>;
  return <m.div className={className} {...data} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={enter("fast")}>{children}</m.div>;
}
