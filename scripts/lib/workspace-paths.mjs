import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
export const LOCAL_ROOT = join(PROJECT_ROOT, ".local");
export const DIST_DIR = join(PROJECT_ROOT, "dist");
export const SHOTS_DIR = join(LOCAL_ROOT, "screenshots", "music");
export const BROWSER_FIXTURES = join(LOCAL_ROOT, "fixtures", "browser");
export const VLC_FIXTURES = join(LOCAL_ROOT, "fixtures", "vlc");
export const STATIC_SERVER = join(
  PROJECT_ROOT,
  "scripts",
  "e2e",
  "serve-dist.mjs",
);

const browserCandidates = [
  process.env.RHINE_BROWSER,
  join(
    process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
  join(
    process.env.ProgramFiles || "C:/Program Files",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe",
  ),
  join(
    process.env.ProgramFiles || "C:/Program Files",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe",
  ),
].filter(Boolean);
export const BROWSER =
  process.env.RHINE_BROWSER ||
  browserCandidates.find(existsSync) ||
  browserCandidates[0];

export function profilePath(name) {
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error("Invalid browser profile name");
  // Keep migrated profiles as evidence; each check owns a fresh, separate profile.
  return join(LOCAL_ROOT, "browser-profiles", `${name}-run-${process.pid}`);
}

export function assertLocalPath(path) {
  const absolute = resolve(path);
  const child = relative(LOCAL_ROOT, absolute);
  if (
    !child ||
    child === ".." ||
    child.startsWith("../") ||
    child.startsWith("..\\") ||
    isAbsolute(child)
  ) {
    throw new Error(`Cleanup path must be inside .local: ${absolute}`);
  }
  return absolute;
}

export async function resetLocalDirectory(path) {
  const target = assertLocalPath(path);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

export async function removeLocalDirectory(path) {
  await rm(assertLocalPath(path), { recursive: true, force: true });
}

export function requireE2EEnvironment() {
  if (!existsSync(join(DIST_DIR, "index.html")))
    throw new Error("Run npm run build before the browser checks.");
  if (!existsSync(BROWSER))
    throw new Error(
      "Set RHINE_BROWSER to an installed Edge or Chrome executable.",
    );
}
