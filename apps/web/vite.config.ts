import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { appVersion } from "../../scripts/app-version.mjs";

/** Gateway to proxy the WebSocket to during development (`pnpm dev:gateway` listens on 8080). */
const gateway = process.env.GATEWAY_URL ?? "http://localhost:8080";

/** Shown in the status bar (src/version.ts); the package passes the version it also gives the gateway. */
const version = process.env.RPP_VERSION ?? appVersion(fileURLToPath(new URL("../..", import.meta.url)));

/** The pages of the web app (ADR 0016): the visualisation and the configurator, sharing their libraries' chunks. */
const pages = {
  main: fileURLToPath(new URL("index.html", import.meta.url)),
  configurator: fileURLToPath(new URL("configurator.html", import.meta.url)),
};

/** In development, /configurator opens the configurator page as the gateway does with the built app. */
const configuratorPath: Plugin = {
  name: "rpp-configurator-path",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/configurator\/?(\?.*)?$/.test(req.url)) req.url = req.url.replace(/^\/configurator\/?/, "/configurator.html");
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), configuratorPath],
  define: { __RPP_VERSION__: JSON.stringify(version) },
  build: {
    // No script above this (checked by the browser tests): weak panel PCs load the parts in parallel, and an update of
    // the app reloads only its own code, not the libraries.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: pages,
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
      // Served by the gateway too: the PLC library guide and the JSON Schema (ADR 0014) and the health report.
      "/docs": gateway,
      "/health": gateway,
    },
  },
  test: {
    environment: "node",
  },
});
