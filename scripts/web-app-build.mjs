// The build settings the web apps share (ADR 0019): the visualisation, the configurator and the Simulator each have
// their own Vite config that spreads these and adds its plugins and its base path.
import { appVersion } from "./app-version.mjs";
import { fileURLToPath } from "node:url";

/** Gateway to proxy the WebSocket to during development (`pnpm dev:gateway` listens on 8080). */
const gateway = process.env.GATEWAY_URL ?? "http://localhost:8080";

/** Shown in the status bar (APP_VERSION of @rpp/machine-view); the package passes the version it also gives the gateway. */
const version = process.env.RPP_VERSION ?? appVersion(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The package after the last node_modules (pnpm nests them under .pnpm); module ids use "/" on Windows too. No script
 * above 800 KB (checked by the browser tests): weak panel PCs load the parts in parallel, and an update of the app
 * reloads only its own code, not the libraries.
 */
function manualChunks(id) {
  const pkg = /.*\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(id)?.[1];
  if (!pkg) return undefined;
  if (pkg === "three") return "three";
  if (pkg.startsWith("@react-three/") || pkg === "three-stdlib" || pkg === "three-mesh-bvh") return "react-three";
  if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "react";
  return "vendor";
}

/** The shared part of a web app's Vite config; `base` is the path the gateway serves the app at. */
export function webAppConfig({ base = "/" } = {}) {
  return {
    base,
    define: { __RPP_VERSION__: JSON.stringify(version) },
    // One React, also for @rpp/machine-view's modules (three.js comes only through the package).
    resolve: { dedupe: ["react", "react-dom"] },
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: { output: { manualChunks } },
    },
    server: {
      proxy: {
        "/ws": { target: gateway, ws: true },
        // Served by the gateway too: the PLC library guide and the JSON Schema (ADR 0014) and the health report.
        "/docs": gateway,
        "/health": gateway,
      },
    },
    test: { environment: "node" },
  };
}
