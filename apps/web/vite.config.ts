import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Gateway to proxy the WebSocket to during development (`pnpm dev:gateway` listens on 8080). */
const gateway = process.env.GATEWAY_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  // three.js dominates the bundle; acceptable for a tool served on the machine network.
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      "/ws": { target: gateway, ws: true },
    },
  },
  test: {
    environment: "node",
  },
});
