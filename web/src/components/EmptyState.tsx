import type { ComponentType, ReactNode } from "react";

/** Icon, one sentence and an optional action for an empty list or page. */
export function EmptyState({ icon: Icon, children, action }: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
      <Icon aria-hidden className="size-5 text-muted-foreground" />
      <p className="max-w-prose text-sm text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}
