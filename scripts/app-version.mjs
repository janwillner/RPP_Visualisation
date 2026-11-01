// The version of a visualisation build, shared by the package (gateway bundle, VERSION file, zip name) and the web app:
//   - built by CI from a tag v1.2.3:   1.2.3
//   - otherwise:                       <package.json version>+<commit>, e.g. 0.1.0+aa29151, with ".dirty" when the app's
//                                      sources have uncommitted changes, so two such builds are never mistaken for one
//   - without git:                     the package.json version

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Folders whose changes make a build differ from its commit. */
const SOURCES = ["apps", "packages", "deploy", "scripts", "package.json", "pnpm-lock.yaml"];

export function appVersion(root) {
  const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (tag) {
    if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`Tag "${tag}" is not a version tag like v1.2.3.`);
    return tag.slice(1);
  }
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!version) throw new Error('No version: set "version" in package.json or build from a v* tag.');
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const commit = git("rev-parse", "--short", "HEAD");
    const dirty = git("status", "--porcelain", "--", ...SOURCES) !== "";
    return `${version}+${commit}${dirty ? ".dirty" : ""}`;
  } catch {
    return version;
  }
}
