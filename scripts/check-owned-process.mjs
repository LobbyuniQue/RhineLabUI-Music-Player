// Regression: cleanup must stop the check's process, while a separate process
// using the same executable remains alive. Windows also verifies descendants.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopProcessTree } from "./lib/owned-process.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const worker = "setTimeout(() => process.exit(0), 15000); console.log(process.pid);";
function start(source) {
  return spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}
async function ready(child) {
  if (!child.pid) throw new Error("Worker did not start");
  const line = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => String(chunk).trim()),
    once(child, "error").then(([error]) => Promise.reject(error)),
    sleep(5000).then(() => { throw new Error("Worker startup timed out"); }),
  ]);
  return Number(line);
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function gone(pid) {
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  assert.equal(alive(pid), false, `Owned process ${pid} survived cleanup`);
}

const guardian = start(worker);
const owned = start(process.platform === "win32"
  ? `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','pipe','ignore'],windowsHide:true}); child.stdout.pipe(process.stdout); setTimeout(()=>process.exit(0),15000);`
  : worker);
let descendant;
try {
  await ready(guardian);
  descendant = await ready(owned);
  assert.equal(alive(guardian.pid), true);
  await stopProcessTree(owned);
  await gone(owned.pid);
  if (process.platform === "win32") await gone(descendant);
  assert.equal(alive(guardian.pid), true, "Cleanup interrupted the unrelated process");
  await stopProcessTree(owned); // Cleaning an exited child is harmless.
  assert.equal(alive(guardian.pid), true);
  console.log("ok  owned cleanup preserves an unrelated process with the same executable");
  if (process.platform === "win32") console.log("ok  owned descendant exits with its process tree");
} finally {
  await stopProcessTree(owned);
  await stopProcessTree(guardian);
  // This PID was reported by the worker created above, never discovered by name.
  if (descendant && descendant !== owned.pid && alive(descendant)) process.kill(descendant);
}
