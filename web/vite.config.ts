import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { IncomingMessage, ServerResponse } from "node:http";

function loginRoute(req: IncomingMessage, _res: ServerResponse, next: () => void) {
  if (req.url?.split("?")[0] === "/__vim4/login") req.url = "/login.html" + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");
  next();
}

// Keep offline development local; VIM4_MANAGER selects an explicit backend.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  plugins: [react(), tailwindcss(), { name: "login-route",
    configureServer(server) { server.middlewares.use(loginRoute); },
    configurePreviewServer(server) { server.middlewares.use(loginRoute); },
  }],
  build: { assetsDir: "__vim4/assets", rollupOptions: {
    input: { main: "index.html", login: "login.html" },
  } },
  server: { proxy: {
    "/api": process.env.VIM4_MANAGER ?? "http://127.0.0.1:5189",
    "/__vim4/api": process.env.VIM4_MANAGER ?? "http://127.0.0.1:5189",
  } },
});
