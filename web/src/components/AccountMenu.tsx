import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown, LogOut, UserRound } from "lucide-react";
import { request } from "@/api";
import { logout, useAccount } from "@/auth";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function Avatar({ username, className }: { username: string; className?: string }) {
  const initial = [...username][0] || "";
  return (
    <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary", className)}>
      {/^\p{L}$/u.test(initial) ? initial.toUpperCase() : <UserRound className="size-4" />}
    </span>
  );
}

/**
 * Account menu: the sidebar shows name and role, the mobile top bar only the
 * avatar. Closes on route change and Tab; a failed logout keeps it open.
 */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { username } = useAccount();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setAddress("");
    request<{ sessions: { current: boolean; address: string }[] }>("/api/account/sessions", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setAddress(value.sessions.find((device) => device.current)?.address || "");
      })
      .catch(() => {});
    const close = () => setOpen(false);
    window.addEventListener("hashchange", close);
    return () => {
      controller.abort();
      window.removeEventListener("hashchange", close);
    };
  }, [open]);

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await logout();
    } catch {
      setError("退出失败，请重试");
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  const current = location.hash === "#/account";
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={(next) => { if (next) setError(""); setOpen(next); }}>
      <DropdownMenuTrigger ref={trigger} aria-label="账户菜单"
        className={cn("flex items-center gap-2 rounded-md text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent",
          compact ? "size-9 justify-center" : "w-full p-1.5", current && "bg-sidebar-accent")}>
        <Avatar username={username} />
        {!compact && (
          <>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <strong className="truncate text-sm font-medium text-foreground">{username}</strong>
              <small className="text-xs text-muted-foreground">管理员</small>
            </span>
            <ChevronsUpDown aria-hidden="true" className="size-4 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent loop side={compact ? "bottom" : "top"} align={compact ? "end" : "start"}
        className={compact ? "w-56" : "w-(--radix-dropdown-menu-trigger-width) min-w-52"}
        onKeyDown={(event) => { if (event.key === "Tab") setOpen(false); }}
        // The trigger toggles on its own press; do not also treat it as an outside dismiss.
        onPointerDownOutside={(event) => { if (trigger.current?.contains(event.target as Node)) event.preventDefault(); }}>
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <strong className="truncate text-sm font-medium text-foreground">{username}</strong>
          {address && <small className="text-xs text-muted-foreground">本设备 {address}</small>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { location.hash = "/account"; }}>
          <UserRound />
          账户与登录设备
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={(event) => { event.preventDefault(); void signOut(); }}>
          <LogOut />
          {busy ? "正在退出…" : "退出登录"}
        </DropdownMenuItem>
        {error && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
