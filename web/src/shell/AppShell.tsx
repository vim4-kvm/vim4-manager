import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, LazyMotion, m, MotionConfig, useReducedMotion } from "motion/react";
import { Menu } from "lucide-react";
import { AccountMenu } from "@/components/AccountMenu";
import { Button } from "@/components/ui/button";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { enter, exit } from "@/lib/motion";

// Animation features load after first paint; until then m.* renders statically.
const animationFeatures = () => import("@/lib/motion-dom").then((module) => module.default);
import { AppSidebar } from "./AppSidebar";
import { pageMeta, type PageId } from "./pages";

function MobileTopBar({ title }: { title: string }) {
  const { setOpenMobile } = useSidebar();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur-sm md:hidden">
      <Button variant="ghost" size="icon" className="size-10" aria-label="打开菜单" onClick={() => setOpenMobile(true)}>
        <Menu className="size-5" />
      </Button>
      <span className="min-w-0 flex-1 truncate text-base font-semibold">{title}</span>
      <AccountMenu compact />
    </header>
  );
}

function PageHeader({ page }: { page: PageId }) {
  const meta = pageMeta(page);
  return (
    <header className="mb-6 flex flex-col gap-1">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">{meta.title}</h1>
      {meta.description && <p className="max-w-prose text-sm text-pretty text-muted-foreground">{meta.description}</p>}
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
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    main.current?.focus({ preventScroll: true });
  }, [page]);
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={animationFeatures} strict>
        {/* Desktop stays expanded: the spec has no collapsed icon rail. */}
        <SidebarProvider open onOpenChange={() => {}}>
          <AppSidebar page={page} />
          <div className="flex min-w-0 flex-1 flex-col">
            <MobileTopBar title={pageMeta(page).title} />
            <main ref={main} tabIndex={-1} aria-labelledby="page-title"
              className="mx-auto w-full max-w-[880px] px-4 pt-4 pb-16 outline-none md:px-8 md:pt-8">
              <PageTransition page={page}>
                <PageHeader page={page} />
                <div className="flex flex-col gap-6">{children}</div>
              </PageTransition>
            </main>
          </div>
        </SidebarProvider>
        <Toaster position="bottom-right" closeButton containerAriaLabel="通知"
          toastOptions={{
            closeButtonAriaLabel: "关闭",
            classNames: {
              toast: "cn-toast",
              error: "[&_[data-icon]]:text-destructive",
              success: "[&_[data-icon]]:text-success",
              warning: "[&_[data-icon]]:text-warning",
            },
          }} />
      </LazyMotion>
    </MotionConfig>
  );
}
