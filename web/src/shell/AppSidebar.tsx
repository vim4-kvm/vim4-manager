import { useShallow } from "zustand/react/shallow";
import { Monitor } from "lucide-react";
import { StatusDot } from "@/components/StatusDot";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { usePassthroughStore } from "@/stores/passthrough";
import { useStatusStore } from "@/stores/status";
import { navHint, PAGE_GROUPS, PAGES, type PageId } from "./pages";
import { preloadPage } from "./routes";

const hintTones = {
  good: "text-success-foreground",
  warning: "text-warning-foreground",
  critical: "text-destructive",
  idle: "",
};

function Brand() {
  return (
    <a href="#/overview" aria-label="VIM4 KVM 管理面板" className="flex h-12 items-center gap-2.5 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:px-0">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-fill text-primary-foreground"><Monitor className="size-4" /></span>
      <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
        <span data-brand className="text-sm font-semibold text-foreground">VIM4 KVM</span>
        <span className="mt-0.5 text-xs text-muted-foreground">管理面板</span>
      </span>
    </a>
  );
}

function Navigation({ page }: { page: PageId }) {
  const status = useStatusStore((s) => s.status);
  const passthrough = usePassthroughStore((s) => s.state);
  const { setOpenMobile } = useSidebar();
  return (
    <nav aria-label="页面">
      {PAGE_GROUPS.map((group) => (
        <SidebarGroup key={group}>
          <SidebarGroupLabel>{group}</SidebarGroupLabel>
          <SidebarMenu className="gap-1">
            {PAGES.filter((p) => p.group === group).map((p) => {
              const hint = navHint(p.id, status, passthrough);
              const tone = hint?.tone;
              const Icon = p.icon;
              const label = hint ? `${p.title} · ${hint.text}` : p.title;
              return (
                <SidebarMenuItem key={p.id}>
                  <SidebarMenuButton asChild isActive={page === p.id} className="h-9 gap-2.5 text-sidebar-foreground max-md:h-10 data-[active=true]:text-sidebar-accent-foreground">
                    <a href={`#/${p.id}`} title={label} aria-label={label} aria-current={page === p.id ? "page" : undefined} onClick={() => setOpenMobile(false)}
                      onPointerEnter={() => preloadPage(p.id)} onFocus={() => preloadPage(p.id)}>
                      <Icon aria-hidden="true" className="size-4!" />
                      <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">{p.title}</span>
                      {hint && (
                        <span data-nav-hint={p.id} data-tone={tone} className={cn("ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden", tone && hintTones[tone])}>
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
        </SidebarGroup>
      ))}
    </nav>
  );
}

function Connection() {
  const { status, stale } = useStatusStore(useShallow((s) => ({ status: s.status, stale: s.stale })));
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 text-xs group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
      <span className="flex min-w-0 items-center gap-2 text-sidebar-foreground">
        <span title={stale ? "连接中断" : status ? status.hardware.hostname : "连接中"}><StatusDot tone={stale ? "critical" : status ? "good" : "warning"} /></span>
        <span className="truncate group-data-[collapsible=icon]:sr-only">{stale ? "连接中断" : status ? status.hardware.hostname : "连接中"}</span>
      </span>
      {status && <span data-kernel className="truncate pl-4 font-mono text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">{status.hardware.kernel}</span>}
    </div>
  );
}

export function AppSidebar({ page }: { page: PageId }) {
  const { isMobile, state } = useSidebar();
  return (
    <Sidebar collapsible="icon" className="border-sidebar-border">
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border p-2">
        <Brand />
      </SidebarHeader>
      <SidebarContent className="gap-1 py-2">
        <Navigation page={page} />
      </SidebarContent>
      <SidebarFooter className="gap-4 border-t border-sidebar-border p-3 group-data-[collapsible=icon]:px-2">
        <Connection />
        <ThemeSwitch compact={!isMobile && state === "collapsed"} />
      </SidebarFooter>
    </Sidebar>
  );
}
