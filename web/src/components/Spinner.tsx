import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** The one busy indicator; decorative, so pair it with visible or live text. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={cn("size-4 shrink-0 motion-safe:animate-spin", className)} />;
}
