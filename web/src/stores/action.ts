import { toast } from "sonner";
import { create } from "zustand";
import { useStatusStore } from "./status";

export type Run = (label: string, action: () => Promise<unknown>, done: string) => Promise<boolean>;
export type Tone = "good" | "warning" | "critical";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const inlineErrors = new Map<symbol, string>();
const errorToasts = new Map<string | number, string>();
const sameFailure = (inline: string, error: string) => !!inline.trim() && !!error.trim()
  && (inline.includes(error.trim()) || error.includes(inline.trim()));

/** InlineError owns a visible failure, including its page-specific prefix. */
export function registerInlineError(text: string) {
  const key = Symbol();
  inlineErrors.set(key, text);
  for (const [id, error] of errorToasts) {
    if (sameFailure(text, error)) {
      toast.dismiss(id);
      errorToasts.delete(id);
    }
  }
  return () => { inlineErrors.delete(key); };
}

function reportError(text: string) {
  if ([...inlineErrors.values()].some((inline) => sameFailure(inline, text))) return;
  const id = toast.error(text, { duration: Infinity, onDismiss: (t) => { errorToasts.delete(t.id); } });
  errorToasts.set(id, text);
}

/** Replaces the previous message, like the single page banner it supersedes. */
export function report(tone: Tone, text: string) {
  toast.dismiss();
  errorToasts.clear();
  if (tone === "critical") reportError(text);
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
    errorToasts.clear();
    const loading = toast.loading(label);
    try {
      await action();
      toast.dismiss(loading);
      toast.success(done);
      return true;
    } catch (error) {
      toast.dismiss(loading);
      reportError(message(error));
      return false;
    } finally {
      set({ busy: undefined });
      void useStatusStore.getState().refresh();
    }
  },
}));
