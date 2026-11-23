import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA lives in src/web and is built into dist/client, which the Worker serves as
// static assets. During `vite dev`, /api is proxied to `wrangler dev` (port 8787); the
// Origin header is rewritten so the Worker's CSRF check (Origin === APP_URL) passes.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", "http://localhost:8787");
          });
        },
      },
    },
  },
});
