import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { webAppConfig } from "../../scripts/web-app-build.mjs";

/** The visualisation (ADR 0019), served by the gateway at `/`. */
export default defineConfig({ ...webAppConfig(), plugins: [react()] });
