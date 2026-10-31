import { cn } from "@/lib/utils";

/** Physical port silkscreen; protocol names remain untranslated. */
export function PortTag({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-[4px] border bg-muted px-1.5 font-mono text-xs font-medium leading-none text-foreground/80", className)}>{children}</span>;
}
