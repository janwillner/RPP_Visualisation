// Builds the self-contained Windows package for Beckhoff IPCs (ADR 0004):
//   dist/rpp-visualisation-<version>-win-x64.zip
// containing node.exe, the bundled gateway, the web app, the self-contained ADS bridge, the WinSW service
// wrapper, the install scripts and the compiled PLC libraries (plc/Syn_Visu_<version>.compiled-library and
// plc/Syn_Config_<version>.compiled-library, the newest of each in plc/library, without source code). Needs Windows, Node and the .NET SDK; downloads are cached in .cache/.
//
// Version: see app-version.mjs (1.2.3 from a CI tag, else e.g. 0.1.0+aa29151). It goes into the gateway bundle, the
// web app, the VERSION file and the zip name.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// The guide the gateway shows at /docs and the folder of its diagrams; keep in step with apps/gateway/src/docs-texts.ts.
const GUIDE_FILE = "plc-library-guide.md";
const IMAGES_DIR = "images";
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
  define: {
    // The release version reported at /health and in the log (apps/gateway/src/version.ts).
    __RPP_VERSION__: JSON.stringify(version),
    // The PLC library guide at /docs and its diagrams (apps/gateway/src/docs-texts.ts), so the package needs no docs
    // folder.
    __RPP_DOCS__: JSON.stringify({
      guide: readFileSync(join(root, "docs", GUIDE_FILE), "utf8"),
      images: Object.fromEntries(
        readdirSync(join(root, "docs", IMAGES_DIR)).map((file) => [file, readFileSync(join(root, "docs", IMAGES_DIR, file), "utf8")]),
      ),
    }),
  },
  logLevel: "warning",
});

// Both web apps show the same version as the gateway, even when the tree changes while packaging. The configurator goes
// into web/configurator/, where the gateway finds it (ADR 0019).
for (const [app, target] of [["visualisation", "web"], ["configurator", "web/configurator"]]) {
  step(`Building the ${app}`);
  run(process.execPath, [join(root, `apps/${app}/node_modules/vite/bin/vite.js`), "build"], join(root, `apps/${app}`), {
    RPP_VERSION: version,
  });
  cpSync(join(root, `apps/${app}/dist`), join(out, target), { recursive: true });
}

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

mkdirSync(join(out, "plc"));
// Syn_Visu for the visualisation, Syn_Config for the configurator's parameter sets (ADR 0017).
for (const name of ["Syn_Visu", "Syn_Config"]) {
  const library = newestCompiledLibrary(name);
  step(`Adding the PLC library ${library}`);
  cpSync(join(root, "plc/library", library), join(out, "plc", library));
}

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

/**
 * The compiled library `name` (Syn_Visu, Syn_Config) of the highest version in plc/library (exported from XAE with
 * "Save as compiled library", so it holds no source code). It must exist: a package never ships without the
 * libraries its PLC programs need.
 */
function newestCompiledLibrary(name) {
  const pattern = new RegExp(`^${name}_(\\d+)\\.(\\d+)\\.(\\d+)\\.compiled-library$`);
  const found = readdirSync(join(root, "plc/library"))
    .map((file) => ({ file, match: pattern.exec(file) }))
    .filter((f) => f.match)
    .map((f) => ({ file: f.file, parts: f.match.slice(1).map(Number) }))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  if (!found.length) fail(`No plc/library/${name}_<version>.compiled-library: export it from XAE first.`);
  return found[0].file;
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
