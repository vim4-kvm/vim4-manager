import { create } from "zustand";

/** Signed-in administrator; undefined until the auth gate confirms a session. */
export const useSessionStore = create<{
  username?: string;
  setUsername: (username: string) => void;
}>()((set) => ({
  username: undefined,
  setUsername: (username) => set({ username }),
}));
