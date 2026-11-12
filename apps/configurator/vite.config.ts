import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { webAppConfig } from "../../scripts/web-app-build.mjs";

/** The configurator (ADR 0016, 0019), served by the gateway at `/configurator/`; in development too. */
export default defineConfig({ ...webAppConfig({ base: "/configurator/" }), plugins: [react()] });
