import { spawn } from "node:child_process";

/** Stop only the process tree started by this check. */
export async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    child.kill();
    return;
  }
  await new Promise((resolve) => {
    const cleanup = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    cleanup.once("error", resolve);
    cleanup.once("exit", resolve);
  });
  // Restricted Windows sessions can deny taskkill even for an owned process.
  // The ChildProcess handle still lets Node close the child it created.
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
