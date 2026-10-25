import { toast } from "sonner";
import { create } from "zustand";
import { useStatusStore } from "./status";

export type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;
export type Tone = "good" | "warning" | "critical";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Replaces the previous message, like the single page banner it supersedes. */
export function report(tone: Tone, text: string) {
  toast.dismiss();
  if (tone === "critical") toast.error(text, { duration: Infinity });
  else if (tone === "warning") toast.warning(text);
  else toast.success(text);
}

interface ActionStore {
  /** Label of the one blocking action in progress. */
  busy?: string;
  run: Run;
}

export const useActionStore = create<ActionStore>()((set, get) => ({
  busy: undefined,
  run: async (label, action, done) => {
    if (get().busy) return false;
    set({ busy: label });
    toast.dismiss();
    const pending = Promise.resolve().then(action);
    // Errors stay until dismissed or replaced by the next action.
    toast.promise(pending, { loading: label, success: done, error: (e: unknown) => ({ message: message(e), duration: Infinity }) });
    try {
      await pending;
      return true;
    } catch {
      return false;
    } finally {
      set({ busy: undefined });
      void useStatusStore.getState().refresh();
    }
  },
}));
