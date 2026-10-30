// Builds the self-contained Windows package for Beckhoff IPCs (ADR 0004):
//   dist/rpp-visualisation-<version>-win-x64.zip
// containing node.exe, the bundled gateway, the web app, the self-contained ADS bridge, the WinSW service
// wrapper and the install scripts. Needs Windows, Node and the .NET SDK; downloads are cached in .cache/.
//
// Version: the tag in GITHUB_REF_NAME (v1.2.3 -> 1.2.3) when built by CI, else "version" in package.json.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Pinned third-party binaries with their SHA-256. When bumping Node, take the win-x64/node.exe line from
// https://nodejs.org/dist/<version>/SHASUMS256.txt. WinSW: v2.12.0, self-contained x64 build.
const NODE_VERSION = "v24.22.2";
const NODE_SHA256 = "1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9";
const WINSW_URL = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";
const WINSW_SHA256 = "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".cache", "package");
const version = resolveVersion();
const name = `rpp-visualisation-${version}-win-x64`;
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
  logLevel: "warning",
});

step("Building the web app");
run(process.execPath, [join(root, "apps/web/node_modules/vite/bin/vite.js"), "build"], join(root, "apps/web"));
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
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (tag) {
    if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) fail(`Tag "${tag}" is not a version tag like v1.2.3.`);
    return tag.slice(1);
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!version) fail('No version: set "version" in package.json or build from a v* tag.');
  return version;
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

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function step(message) {
  console.log(`\n> ${message}`);
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}
