import { useShallow } from "zustand/react/shallow";
import { AccountMenu } from "@/components/AccountMenu";
import { StatusDot } from "@/components/StatusDot";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { usePassthroughStore } from "@/stores/passthrough";
import { useStatusStore } from "@/stores/status";
import { navHint, PAGES, type PageId } from "./pages";

const hintTones = {
  good: "text-success-foreground",
  warning: "text-warning-foreground",
  critical: "text-destructive",
  idle: "",
};

function Brand() {
  return (
    <div className="flex h-10 items-center gap-2 px-2">
      <span aria-hidden="true" className="grid size-6 place-items-center rounded-md bg-primary-fill text-[10px] font-bold text-primary-foreground">V4</span>
      <span data-brand className="text-sm font-semibold text-foreground">VIM4</span>
      <span className="text-sm text-muted-foreground">KVM</span>
    </div>
  );
}

function Navigation({ page }: { page: PageId }) {
  const status = useStatusStore((s) => s.status);
  const passthrough = usePassthroughStore((s) => s.state);
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="页面" className="px-2">
      <SidebarMenu className="gap-0.5">
        {PAGES.map((p) => {
          const hint = navHint(p.id, status, passthrough);
          const tone = hint?.tone;
          const Icon = p.icon;
          return (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton asChild isActive={page === p.id} className="h-8 gap-2.5 text-sidebar-foreground max-md:h-10 data-[active=true]:text-sidebar-accent-foreground">
                <a href={`#/${p.id}`} aria-current={page === p.id ? "page" : undefined} onClick={() => setOpenMobile(false)}>
                  <Icon aria-hidden="true" className="size-5!" />
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  {hint && (
                    <span data-nav-hint={p.id} data-tone={tone} className={cn("ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums", tone && hintTones[tone])}>
                      {tone && <StatusDot tone={tone} className="size-1.5" />}
                      {hint.text}
                    </span>
                  )}
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </nav>
  );
}

function Connection() {
  const { status, stale } = useStatusStore(useShallow((s) => ({ status: s.status, stale: s.stale })));
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2 text-xs">
      <span className="flex min-w-0 items-center gap-2 text-sidebar-foreground">
        <StatusDot tone={stale ? "critical" : status ? "good" : "warning"} />
        <span className="truncate">{stale ? "连接中断" : status ? status.hardware.hostname : "连接中"}</span>
      </span>
      {status && <span data-kernel className="truncate pl-4 font-mono text-[11px] text-muted-foreground">{status.hardware.kernel}</span>}
    </div>
  );
}

export function AppSidebar({ page }: { page: PageId }) {
  const { isMobile } = useSidebar();
  return (
    <Sidebar className="border-sidebar-border">
      <SidebarHeader className="p-2 pt-3">
        <Brand />
      </SidebarHeader>
      <SidebarContent className="py-2">
        <Navigation page={page} />
      </SidebarContent>
      <SidebarFooter className="gap-3 border-t border-sidebar-border p-3">
        <Connection />
        <ThemeSwitch />
        {!isMobile && <AccountMenu />}
      </SidebarFooter>
    </Sidebar>
  );
}
