import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function IconButton({ icon: Icon, label, pressed, ...props }: {
  icon: LucideIcon; label: string; pressed?: boolean; onClick: () => void; disabled?: boolean;
}) {
  return <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={label} title={label} aria-pressed={pressed} {...props}>
    <Icon aria-hidden="true" className="size-4" />
  </Button>;
}
