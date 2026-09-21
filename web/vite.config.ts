import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = process.env.PI_WEB_SIMPLE_PORT ?? "4319";
const API_TARGET = `http://127.0.0.1:${API_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly: `localhost` can resolve to ::1 only, which makes
    // the dev server unreachable from tools that dial 127.0.0.1.
    host: "127.0.0.1",
    port: 5319,
    strictPort: true,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
        // SSE must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              delete proxyRes.headers["content-encoding"];
            }
          });
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
    },
  },
});
