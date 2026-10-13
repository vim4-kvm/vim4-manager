import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `pnpm dev` proxies the API to a board; set VIM4_MANAGER to override.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": process.env.VIM4_MANAGER ?? "http://192.168.50.210" } },
});
