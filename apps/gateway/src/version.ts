declare const __RPP_VERSION__: string | undefined;

/**
 * Version of this visualisation release, e.g. `1.2.3` (built from a tag) or `0.1.0+aa29151` (package.json version
 * and commit). The package bundle sets it at build time (`scripts/app-version.mjs`); run from the repo it is `dev`.
 */
export const APP_VERSION: string = typeof __RPP_VERSION__ === "string" ? __RPP_VERSION__ : "dev";
