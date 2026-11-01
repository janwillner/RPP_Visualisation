// Builds the self-contained Windows package for Beckhoff IPCs (ADR 0004):
//   dist/rpp-visualisation-<version>-win-x64.zip
// containing node.exe, the bundled gateway, the web app, the self-contained ADS bridge, the WinSW service
// wrapper and the install scripts. Needs Windows, Node and the .NET SDK; downloads are cached in .cache/.
//
// Version: see app-version.mjs (1.2.3 from a CI tag, else e.g. 0.1.0+aa29151). It goes into the gateway bundle, the
// web app, the VERSION file and the zip name.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { appVersion } from "./app-version.mjs";

// Pinned third-party binaries with their SHA-256. When bumping Node, take the win-x64/node.exe line from
// https://nodejs.org/dist/<version>/SHASUMS256.txt. WinSW: v2.12.0, self-contained x64 build.
const NODE_VERSION = "v24.22.2";
const NODE_SHA256 = "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9";
const WINSW_URL = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";
const WINSW_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".cache", "package");
const version = resolveVersion();
// "+" separates the commit in the version; file names and download links keep a plain "-".
const fileVersion = version.replace("+", "-");
const name = `rpp-visualisation-${fileVersion}-win-x64`;
const out = join(root, "dist", name);
const zip = join(root, "dist", `${name}.zip`);

if (process.platform !== "win32") fail("The Windows package must be built on Windows.");

step(`Packaging ${name}`);
rmSync(out, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

step("Bundling the gateway");
await build({
  entryPoints: [join(root, "apps/gateway/src/main.ts")],
  outfile: join(out, "gateway.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Optional native speed-ups of ws; it falls back to plain JS when they are missing.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS dependencies call require() for Node built-ins, which an ESM bundle does not provide by itself.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  // The release version reported at /health and in the log (apps/gateway/src/version.ts).
  define: { __RPP_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});

step("Building the web app");
// The web app shows the same version as the gateway, even when the tree changes while packaging.
run(process.execPath, [join(root, "apps/web/node_modules/vite/bin/vite.js"), "build"], join(root, "apps/web"), {
  RPP_VERSION: version,
});
cpSync(join(root, "apps/web/dist"), join(out, "web"), { recursive: true });

step("Publishing the ADS bridge (self-contained, single file)");
const bridgeOut = join(cache, "bridge");
rmSync(bridgeOut, { recursive: true, force: true });
run("dotnet", [
  "publish", join(root, "apps/ads-bridge"),
  "-c", "Release", "-r", "win-x64", "--self-contained", "true",
  "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true", "-p:DebugType=none",
  "-o", bridgeOut,
]);
cpSync(join(bridgeOut, "AdsBridge.exe"), join(out, "AdsBridge.exe"));

step(`Adding Node ${NODE_VERSION}`);
cpSync(await download(`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`, `node-${NODE_VERSION}.exe`, NODE_SHA256), join(out, "node.exe"));

step("Adding the WinSW service wrapper");
cpSync(await download(WINSW_URL, "WinSW-v2.12.0-x64.exe", WINSW_SHA256), join(out, "winsw.exe"));

step("Adding install scripts and docs");
for (const file of ["install.ps1", "uninstall.ps1"]) cpSync(join(root, "deploy/windows", file), join(out, file));
cpSync(join(root, "docs/deployment.md"), join(out, "DEPLOYMENT.md"));
writeFileSync(join(out, "VERSION"), `${version}\n`);

step("Zipping");
run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}'`]);
console.log(`\nDone: ${zip}`);

function resolveVersion() {
  try {
    return appVersion(root);
  } catch (error) {
    fail(error.message);
  }
}

/** Downloads into the cache once and verifies the SHA-256 (also for cached files). */
async function download(url, fileName, sha256) {
  const target = join(cache, fileName);
  if (!existsSync(target)) {
    const response = await fetch(url);
    if (!response.ok) fail(`Download failed (${response.status}): ${url}`);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  const actual = createHash("sha256").update(readFileSync(target)).digest("hex");
  if (actual !== sha256) {
    rmSync(target);
    fail(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
  }
  return target;
}

function run(command, args, cwd = root, env = {}) {
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

function step(message) {
  console.log(`\n> ${message}`);
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}
