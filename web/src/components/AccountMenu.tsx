import { useEffect, useRef, useState, type ReactNode } from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { Languages, LogOut, Monitor, Moon, Sun, SunMoon, UserRound } from "lucide-react";
import { request } from "@/api";
import { logout, useAccount } from "@/auth";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "./Spinner";
import { cn } from "@/lib/utils";
import { languageChoices, selectLocale, useLocale, useT, type Locale } from "@/i18n";
import { selectTheme, useThemePreference, type Theme } from "@/theme";

export function Avatar({ username, className }: { username: string; className?: string }) {
  const initial = [...username][0] || "";
  return (
    <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-medium text-primary", className)}>
      {/^\p{L}$/u.test(initial) ? initial.toUpperCase() : <UserRound className="size-4" />}
    </span>
  );
}

const themeChoices = [
  { value: "light", icon: Sun, key: "theme.light" },
  { value: "dark", icon: Moon, key: "theme.dark" },
  { value: "system", icon: Monitor, key: "theme.system" },
] as const;

/** Menu row with a label and an inline segmented radio group; segments are menu items in arrow-key order. */
function ChoiceRow({ icon, label, value, onChange, children }: {
  icon: ReactNode; label: string; value: string; onChange: (value: string) => void; children: ReactNode;
}) {
  return (
    <div className="flex h-9 items-center gap-1.5 px-1.5 text-sm [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <span className="mr-auto whitespace-nowrap">{label}</span>
      <DropdownMenuRadioGroup aria-label={label} value={value} onValueChange={onChange} className="flex w-32 rounded-md bg-muted p-0.5">
        {children}
      </DropdownMenuRadioGroup>
    </div>
  );
}

function Segment({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem {...props} onSelect={(event) => event.preventDefault()}
      className={cn("grid h-6 flex-1 cursor-default place-items-center rounded-sm text-muted-foreground outline-none transition-colors select-none hover:text-foreground",
        // Same raised tile as Segmented; the inset highlight ring (pointer and keyboard) stays inside the segment.
        "data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-xs data-[state=checked]:ring-1 data-[state=checked]:ring-border dark:data-[state=checked]:bg-input/60",
        "data-highlighted:ring-2! data-highlighted:ring-inset data-highlighted:ring-ring/50!", className)} />
  );
}

/**
 * Avatar menu with account details, appearance and language.
 * Closes on route change and Tab; choices, a failed logout and a failed language load keep it open.
 */
export function AccountMenu() {
  const t = useT();
  const { username } = useAccount();
  const theme = useThemePreference();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [loadingLocale, setLoadingLocale] = useState<Locale>();
  const [localeFailed, setLocaleFailed] = useState(false);
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
    setSignOutFailed(false);
    try {
      await logout();
    } catch {
      setSignOutFailed(true);
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  async function changeLocale(value: Locale) {
    const timer = window.setTimeout(() => setLoadingLocale(value), 150);
    setLocaleFailed(false);
    try { await selectLocale(value); }
    catch { setLocaleFailed(true); }
    finally { window.clearTimeout(timer); setLoadingLocale(undefined); }
  }

  const current = location.hash === "#/account";
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={(next) => { if (next) { setSignOutFailed(false); setLocaleFailed(false); } setOpen(next); }}>
      <DropdownMenuTrigger ref={trigger} aria-label={t("account.menu")}
        className={cn("grid size-9 shrink-0 place-items-center rounded-full outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent",
          current && "bg-sidebar-accent")}>
        <Avatar username={username} />
      </DropdownMenuTrigger>
      <DropdownMenuContent loop side="bottom" align="end" collisionPadding={8} className="w-72"
        onKeyDown={(event) => { if (event.key === "Tab") setOpen(false); }}
        // The trigger toggles on its own press; do not also treat it as an outside dismiss.
        onPointerDownOutside={(event) => { if (trigger.current?.contains(event.target as Node)) event.preventDefault(); }}>
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <strong className="truncate text-sm font-medium text-foreground">{username}</strong>
          {address && <small className="text-xs text-muted-foreground">{t("account.currentAddress", { address })}</small>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ChoiceRow icon={<SunMoon aria-hidden="true" />} label={t("theme.appearance")} value={theme} onChange={(value) => selectTheme(value as Theme)}>
          {themeChoices.map(({ value, icon: Icon, key }) => (
            <Segment key={value} value={value} aria-label={t(key)} title={t(key)}><Icon aria-hidden="true" className="size-4" /></Segment>
          ))}
        </ChoiceRow>
        <ChoiceRow icon={<Languages aria-hidden="true" />} label={t("common.language")} value={locale} onChange={(value) => void changeLocale(value as Locale)}>
          {languageChoices.map(({ value, short }) => (
            <Segment key={value} value={value} lang={value} className="px-2 text-xs">
              <span className={cn("col-start-1 row-start-1", loadingLocale === value && "opacity-0")}>{short}</span>
              {loadingLocale === value && <Spinner className="col-start-1 row-start-1 size-3.5" />}
            </Segment>
          ))}
        </ChoiceRow>
        {localeFailed && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{t("common.connectionFailed")}</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-8" onSelect={() => { location.hash = "/account"; }}>
          <UserRound />
          {t("account.devices")}
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-8" disabled={busy} onSelect={(event) => { event.preventDefault(); void signOut(); }}>
          <LogOut />
          {busy ? t("account.signingOut") : t("account.signOut")}
        </DropdownMenuItem>
        {signOutFailed && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{t("account.signOutFailed")}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
