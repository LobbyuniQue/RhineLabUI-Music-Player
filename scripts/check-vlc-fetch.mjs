// Run the unchanged installer in an owned fixture project with fake HTTP responses.
// This proves its failure/success boundaries without downloading or executing VLC.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_ROOT, resetLocalDirectory, removeLocalDirectory } from "./lib/workspace-paths.mjs";

const root = join(LOCAL_ROOT, "fixtures", `vlc-fetch-run-${process.pid}`);
const project = join(root, "project-中文"), shared = join(root, "shared");
const target = join(shared, "RhineLab", "vlc"), pointer = join(project, ".tools", "vlc-location.json");
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(name), header = Buffer.alloc(30), index = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(filename.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(index, filename); offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const archive = zip([["vlc-3.0.21/vlc.exe", Buffer.from("generated, never executed")], ["vlc-3.0.21/libvlc.dll", Buffer.from("generated")]]);
const digest = createHash("sha256").update(archive).digest("hex");
const runner = join(project, "fixture-fetch.mjs");
async function run(mode, force = true, hash = digest) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...(force ? ["--force"] : [])], {
      cwd: project, env: { ...process.env, LOCALAPPDATA: shared, RHINE_FIXTURE_MODE: mode, RHINE_FIXTURE_SHA: hash }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject); child.once("close", code => resolve({ code, output }));
  });
}
let passed = 0;
async function check(name, work) { await work(); passed++; console.log(`vlc-fetch: ${name}`); }
await resetLocalDirectory(root);
try {
  await mkdir(join(project, "scripts"), { recursive: true }); await mkdir(target, { recursive: true });
  await copyFile(new URL("./fetch-vlc.mjs", import.meta.url), join(project, "scripts", "fetch-vlc.mjs"));
  await writeFile(join(project, "archive.zip"), archive);
  await writeFile(runner, `import { readFile } from "node:fs/promises";
globalThis.fetch = async url => {
  const mode = process.env.RHINE_FIXTURE_MODE;
  if (mode === "offline") throw new Error("network access prohibited in installed-reuse check");
  if (url.endsWith(".sha256")) {
    if (mode === "unreachable") throw new Error("generated connection failure");
    if (mode === "404") return new Response("not found", { status: 404 });
    if (mode === "html") return new Response("<!DOCTYPE html><html>mirror selector</html>");
    if (mode === "empty") return new Response("");
    return new Response((mode === "mismatch" ? "0".repeat(64) : process.env.RHINE_FIXTURE_SHA.toUpperCase()) + " *vlc-3.0.21-win64.zip\\r\\n");
  }
  return new Response(await readFile(new URL("./archive.zip", import.meta.url)));
};
await import("./scripts/fetch-vlc.mjs");
`);
  await writeFile(join(target, "vlc.exe"), "previous installation");
  await writeFile(join(target, "VERSION.txt"), `3.0.20 (win64)\nSHA256 ${"1".repeat(64)}\n`);
  await check("missing, empty, HTML, unreachable and mismatched official checksums cannot install", async () => {
    for (const mode of ["404", "empty", "html", "unreachable", "mismatch"]) {
      const result = await run(mode); assert.notEqual(result.code, 0, `${mode} incorrectly succeeded`);
      assert.equal(await readFile(join(target, "vlc.exe"), "utf8"), "previous installation", `${mode} removed the existing install`);
      await assert.rejects(stat(pointer), { code: "ENOENT" });
    }
  });
  await check("valid official checksum installs and records the exact ZIP hash", async () => {
    const result = await run("valid"); assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SHA256 verified/); assert.equal(await readFile(join(target, "vlc.exe"), "utf8"), "generated, never executed");
    const saved = JSON.parse(await readFile(pointer, "utf8")); assert.equal(saved.sha256, digest); assert.equal(saved.version, "3.0.21"); assert.equal(saved.arch, "win64"); assert.equal(saved.exe, join(target, "vlc.exe"));
  });
  await check("shared verified installation restores a new checkout pointer without network access", async () => {
    await rm(pointer); const result = await run("offline", false); assert.equal(result.code, 0, result.output);
    assert.match(result.output, /already installed: 3.0.21/); assert.equal(JSON.parse(await readFile(pointer, "utf8")).sha256, digest);
  });
  await check("an installed executable without a verification record is not treated as verified", async () => {
    await writeFile(join(target, "VERSION.txt"), "3.0.21 (win64)\n");
    const result = await run("offline", false); assert.notEqual(result.code, 0); assert.doesNotMatch(result.output, /already installed/);
  });
  await check("an archive entry cannot escape into a sibling whose name shares the target prefix", async () => {
    const unsafe = zip([["vlc-3.0.21/../vlc-escape/sentinel", Buffer.from("must not be written")]]);
    await writeFile(join(project, ".tools", "cache", "vlc-3.0.21-win64.zip"), unsafe);
    const result = await run("valid", true, createHash("sha256").update(unsafe).digest("hex"));
    assert.notEqual(result.code, 0); assert.match(result.output, /unsafe archive entry/);
    await assert.rejects(stat(join(shared, "RhineLab", "vlc-escape", "sentinel")), { code: "ENOENT" });
  });
  console.log(`${passed} VLC fetch checks passed.`);
} finally { await removeLocalDirectory(root); }
