declare const __RPP_VERSION__: string;

/** Version of this build, e.g. `1.2.3` or `0.1.0+aa29151`; set by each app's `vite.config.ts` (`dev` without one). */
export const APP_VERSION: string = typeof __RPP_VERSION__ === "string" ? __RPP_VERSION__ : "dev";
