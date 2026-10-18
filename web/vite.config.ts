import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Keep offline development local; VIM4_MANAGER selects an explicit backend.
export default defineConfig({
  plugins: [react(), { name: "login-route", configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.split("?")[0] === "/__vim4/login") req.url = "/login.html" + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");
      next();
    });
  } }],
  build: { assetsDir: "__vim4/assets", rollupOptions: { input: { main: "index.html", login: "login.html" } } },
  server: { proxy: {
    "/api": process.env.VIM4_MANAGER ?? "http://127.0.0.1:5189",
    "/__vim4/api": process.env.VIM4_MANAGER ?? "http://127.0.0.1:5189",
  } },
});
