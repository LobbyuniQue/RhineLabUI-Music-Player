import { spawn } from "node:child_process";
import {
  DIST_DIR,
  STATIC_SERVER,
  BROWSER,
  profilePath,
  resetLocalDirectory,
  removeLocalDirectory,
  requireE2EEnvironment,
} from "../lib/workspace-paths.mjs";
import { stopProcessTree } from "../lib/owned-process.mjs";
const DIST = DIST_DIR;
const PORT = 4196,
  DEBUG_PORT = 9348;
const EDGE = BROWSER;
const PROFILE = profilePath("probe-nav");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
requireE2EEnvironment();
await resetLocalDirectory(PROFILE);

const server = spawn(process.execPath, [STATIC_SERVER, DIST, String(PORT)], {
  stdio: "ignore",
  windowsHide: true,
});
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--no-first-run",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);
try {
  let page;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      ).json();
      page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    socket.addEventListener("open", res);
    socket.addEventListener("error", rej);
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      socket.send(JSON.stringify({ id: i, method, params }));
    });
  const evalJs = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true }))
      ?.result?.value;
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?review=1` });
  await sleep(6000);
  console.log(
    "nav:",
    JSON.stringify(
      await evalJs(
        `document.querySelector("nav.system-nav")?.innerHTML.slice(0, 400) ?? "NO NAV"`,
      ),
    ),
  );
  console.log(
    "button:",
    JSON.stringify(
      await evalJs(
        `Boolean(document.querySelector('[data-action="library-mode"]'))`,
      ),
    ),
  );
  console.log(
    "sw:",
    JSON.stringify(
      await evalJs(
        `navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1`,
      ),
    ),
  );
} finally {
  await Promise.all([stopProcessTree(edge), stopProcessTree(server)]);
  await removeLocalDirectory(PROFILE).catch(() => {});
}
