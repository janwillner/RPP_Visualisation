import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { webAppConfig } from "../../scripts/web-app-build.mjs";

/** The Simulator (ADR 0020, 0022), served by the gateway at `/simulator/`; in development too. */
export default defineConfig({ ...webAppConfig({ base: "/simulator/" }), plugins: [react()] });
