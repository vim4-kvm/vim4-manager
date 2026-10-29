import { useEffect } from "react";
import { create } from "zustand";
import { getStatus, type Status } from "@/api";
import { usePassthroughStore } from "./passthrough";
import { useLocale } from "@/i18n";

const POLL_MS = 3000;

interface StatusStore {
  status?: Status;
  /** The last status poll failed; keep showing the previous status. */
  stale: boolean;
  /** Time of the last successful poll, used for durations shown with it. */
  now: number;
  refresh: () => Promise<void>;
}

export const useStatusStore = create<StatusStore>()((set) => ({
  status: undefined,
  stale: false,
  now: Date.now(),
  refresh: async () => {
    try {
      const next = await getStatus();
      set({ status: next });
      if (next.passthrough) usePassthroughStore.getState().setState(next.passthrough);
      set({ stale: false, now: Date.now() });
    } catch {
      set({ stale: true });
    }
  },
}));

/** Polls overview status for the lifetime of the app shell. */
export function useStatusPolling() {
  const locale = useLocale();
  useEffect(() => {
    const { refresh } = useStatusStore.getState();
    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [locale]);
}
