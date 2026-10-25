import { lazy, type ComponentType } from "react";
import type { PageId } from "./pages";

// Each page is its own chunk so the first paint only carries the shell.
const loaders: Record<PageId, () => Promise<{ default: ComponentType }>> = {
  overview: () => import("@/pages/Overview").then((m) => ({ default: m.Overview })),
  output: () => import("@/pages/PassthroughPanel").then((m) => ({ default: m.PassthroughPanel })),
  apps: () => import("@/pages/Applications").then((m) => ({ default: m.Applications })),
  video: () => import("@/pages/Video").then((m) => ({ default: m.Video })),
  media: () => import("@/MediaPanel").then((m) => ({ default: m.MediaPanel })),
  disks: () => import("@/DiskPanel").then((m) => ({ default: m.DiskPanel })),
  storage: () => import("@/StoragePanel").then((m) => ({ default: m.StoragePanel })),
  cooling: () => import("@/pages/Cooling").then((m) => ({ default: m.Cooling })),
  services: () => import("@/pages/Services").then((m) => ({ default: m.Services })),
  account: () => import("@/AccountPanel").then((m) => ({ default: m.AccountPanel })),
  network: () => import("@/pages/Network").then((m) => ({ default: m.Network })),
  updates: () => import("@/pages/Updates").then((m) => ({ default: m.Updates })),
};

const lazyPages = new Map<PageId, ComponentType>();

/** The lazily loaded component for a page; created once per page. */
export function pageComponent(id: PageId): ComponentType {
  let page = lazyPages.get(id);
  if (!page) lazyPages.set(id, page = lazy(loaders[id]));
  return page;
}

/** Start fetching a page chunk early, e.g. when its nav link is hovered. */
export function preloadPage(id: PageId) {
  void loaders[id]().catch(() => {});
}
