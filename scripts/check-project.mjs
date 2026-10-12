import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "./lib/workspace-paths.mjs";

function run(label, args) {
  console.log(`\n[check] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${label} failed (${result.status ?? result.signal})`);
}

const coreChecks = [
  [
    "TypeScript",
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit"],
  ],
  ...["content", "viewport", "music", "music-player", "music-bridge", "vlc-status", "music-library", "music-reveal", "archive-covers", "owned-process", "playground", "archive-visibility", "pwa-cache", "pwa-redirect"].map(
    (name) => [
      name,
      ["--experimental-strip-types", `scripts/check-${name}.mjs`],
    ],
  ),
];

try {
  if (!process.argv.includes("--tools-only"))
    for (const [label, args] of coreChecks) run(label, args);
  for (const directory of [
    "scripts/lib",
    "scripts/e2e",
    "scripts/diagnostics",
  ]) {
    for (const file of readdirSync(join(PROJECT_ROOT, directory))
      .filter((name) => name.endsWith(".mjs"))
      .sort()) {
      const path = `${directory}/${file}`;
      run(path, ["--check", path]);
    }
  }
  console.log("\n[check] All requested checks passed.");
} catch (error) {
  console.error(`\n[check] ${error.message}`);
  process.exitCode = 1;
}
