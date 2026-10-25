import { create } from "zustand";
import type { PassthroughState } from "@/api";

/** Latest passthrough state, shared by the sidebar hint and the HDMI output page. */
export const usePassthroughStore = create<{
  state?: PassthroughState;
  setState: (state: PassthroughState) => void;
}>()((set) => ({
  state: undefined,
  setState: (state) => set({ state }),
}));
