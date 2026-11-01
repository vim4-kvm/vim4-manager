import { create } from "zustand";
import { getHttps, type HttpsState } from "@/api";

interface HttpsStore {
  https?: HttpsState;
  /** The last read failed. */
  failed: boolean;
  /** Counts writes so a read that started before one cannot overwrite its result. */
  writes: number;
  refresh: () => Promise<void>;
  apply: (next: HttpsState) => void;
}

/** Shared by the HTTPS card, which polls it, and the Tailscale card's access URLs. */
export const useHttpsStore = create<HttpsStore>()((set, get) => ({
  https: undefined,
  failed: false,
  writes: 0,
  refresh: async () => {
    const writes = get().writes;
    try {
      const next = await getHttps(AbortSignal.timeout(12000));
      if (get().writes === writes) set({ https: next, failed: false });
    } catch {
      set({ failed: true });
    }
  },
  apply: (next) => set((s) => ({ https: next, failed: false, writes: s.writes + 1 })),
}));
