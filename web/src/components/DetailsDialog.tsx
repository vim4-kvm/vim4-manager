import { useRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Modal details and forms use Radix for focus trapping, dismissal and restoration. */
export function DetailsDialog({ open, onOpenChange, title, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode;
}) {
  const trigger = useRef(document.activeElement as HTMLElement | null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <Dialog.Content aria-describedby={undefined}
        onOpenAutoFocus={(event) => { const input = (event.target as HTMLElement).querySelector<HTMLInputElement>("input"); if (input) { event.preventDefault(); input.focus(); } }}
        onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus(); }} className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-auto rounded-lg border bg-popover p-5 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0">
        <div className="flex items-center justify-between gap-3">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="关闭"><X className="size-4" /></Button></Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
