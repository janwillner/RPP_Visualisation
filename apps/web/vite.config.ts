import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Gateway to proxy the WebSocket to during development (`pnpm dev:gateway` listens on 8080). */
const gateway = process.env.GATEWAY_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  build: {
    // No script above this (checked by the browser tests): weak panel PCs load the parts in parallel, and an update of
    // the app reloads only its own code, not the libraries.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // The package after the last node_modules (pnpm nests them under .pnpm); module ids use "/" on Windows too.
        manualChunks(id) {
          const pkg = /.*\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(id)?.[1];
          if (!pkg) return undefined;
          if (pkg === "three") return "three";
          if (pkg.startsWith("@react-three/") || pkg === "three-stdlib" || pkg === "three-mesh-bvh") return "react-three";
          if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "react";
          return "vendor";
        },
      },
    },
  },
  server: {
    proxy: {
      "/ws": { target: gateway, ws: true },
    },
  },
  test: {
    environment: "node",
  },
});
