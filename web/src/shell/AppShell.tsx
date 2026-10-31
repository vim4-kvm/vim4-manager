import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, LazyMotion, m, MotionConfig, useReducedMotion } from "motion/react";
import { LucideProvider, Menu, PanelLeft } from "lucide-react";
import { AccountMenu } from "@/components/AccountMenu";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { enter, exit } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Animation features load after first paint; until then m.* renders statically.
const animationFeatures = () => import("@/lib/motion-dom").then((module) => module.default);
import { AppSidebar } from "./AppSidebar";
import { pageMeta, type PageId } from "./pages";

function TopBar({ page }: { page: PageId }) {
  const t = useT();
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  const meta = pageMeta(page);
  return (
    <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-sm md:px-6">
      <Button variant="ghost" size="icon" className="size-9" aria-label={isMobile ? t("nav.openMenu") : open ? t("nav.collapseSidebar") : t("nav.expandSidebar")}
        aria-expanded={isMobile ? openMobile : open} onClick={toggleSidebar}>
        {isMobile ? <Menu /> : <PanelLeft />}
      </Button>
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border md:hidden" />
      <span className="min-w-0 flex-1 truncate font-medium"><span className="md:hidden">{meta.title}</span></span>
      <div className="flex shrink-0 items-center gap-1">
        <LanguageSwitch />
        <ThemeSwitch />
        <AccountMenu compact />
      </div>
    </header>
  );
}

/** Finish the outgoing fade before entering the next page. */
function PageTransition({ page, children }: { page: PageId; children: ReactNode }) {
  const reduced = useReducedMotion();
  if (reduced) return <div key={page}>{children}</div>;
  return <AnimatePresence mode="wait"><m.div key={page}
    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: enter() }}
    exit={{ opacity: 0, transition: exit() }}>{children}</m.div></AnimatePresence>;
}

/** Sidebar, mobile Sheet and top bar, page header, transitions and toasts. */
export function AppShell({ page, children }: { page: PageId; children: ReactNode }) {
  const t = useT();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [page]);
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={animationFeatures} strict>
      <LucideProvider strokeWidth={1.5}>
        <SidebarProvider>
          <AppSidebar page={page} />
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar page={page} />
            <main ref={main} tabIndex={-1} aria-labelledby="page-title"
              className={cn("mx-auto w-full px-4 py-6 pb-16 outline-none md:px-6 lg:px-8", pageMeta(page).wide ? "max-w-7xl" : "max-w-4xl")}>
              <PageTransition page={page}>
                <div className="flex flex-col gap-6">{children}</div>
              </PageTransition>
            </main>
          </div>
        </SidebarProvider>
        <Toaster position="bottom-right" closeButton containerAriaLabel={t("common.notifications")}
          toastOptions={{
            closeButtonAriaLabel: t("common.close"),
            classNames: {
              toast: "cn-toast",
              error: "[&_[data-icon]]:text-destructive",
              success: "[&_[data-icon]]:text-success",
              warning: "[&_[data-icon]]:text-warning",
            },
          }} />
      </LucideProvider>
      </LazyMotion>
    </MotionConfig>
  );
}
