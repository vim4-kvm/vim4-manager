import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** Pollers stop while the tab is hidden and refresh as soon as it is shown again. */
export function usePageVisible() {
  return useSyncExternalStore(subscribe, () => document.visibilityState === "visible");
}
