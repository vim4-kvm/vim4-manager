import type { ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Confirmation for destructive or disruptive actions; labels come from each caller. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirm, cancel = "取消", destructive = false, onConfirm, children, disabled = false, busy = false, closeOnConfirm = true }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirm: string;
  cancel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  closeOnConfirm?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancel}</AlertDialogCancel>
          <AlertDialogAction disabled={busy || disabled} variant={destructive ? "destructive" : "default"}
            onClick={(event) => { if (!closeOnConfirm) event.preventDefault(); onConfirm(); }}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
