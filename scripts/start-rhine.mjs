#!/usr/bin/env node
// Unified Rhine Lab launcher: Vite web UI + optional VLC bridge.
//
// Usage:
//   node scripts/start-rhine.mjs [--root "D:\\Music"]
//   node scripts/start-rhine.mjs --no-music
//   node scripts/start-rhine.mjs --bridge-only ["D:\\Music"]
//
// The launcher owns both long-lived child processes. Closing this process (or
// pressing Ctrl+C) terminates the complete process tree, including VLC.

import { spawn } from "node:child_process";
import { createServer as createProbe } from "node:net";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PROJECT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT_FILE = join(PROJECT, ".tools", "music-root.txt");
const BRIDGE_SCRIPT = join(PROJECT, "scripts", "vlc-bridge.mjs");
const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const args = process.argv.slice(2);
const valueFlags = new Set(["--root", "--port", "--bridge-port", "--web-port", "--token", "--vlc", "--aout"]);
const booleanFlags = new Set(["--bridge-only", "--no-music", "--no-open", "--verbose"]);
const hasFlag = (name) => args.includes(name);
const valueAfter = (name) => {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || undefined;
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
};
const positionalRoot = args.find((value, index) => {
  if (value.startsWith("--")) return false;
  return !valueFlags.has(args[index - 1]);
});

const bridgeOnly = hasFlag("--bridge-only");
const noMusic = hasFlag("--no-music");
const noOpen = hasFlag("--no-open");
const rootArg = valueAfter("--root") ?? positionalRoot;
const explicitRoot = Boolean(rootArg);
const legacyPortArg = valueAfter("--port");
const bridgePortArg = valueAfter("--bridge-port") ?? (bridgeOnly || !noMusic ? legacyPortArg : undefined);
const webPortArg = valueAfter("--web-port") ?? (noMusic && !bridgeOnly ? legacyPortArg : undefined);
const tokenArg = valueAfter("--token");
const vlcArg = valueAfter("--vlc");
const aoutArg = valueAfter("--aout");

const children = new Set();
const cleanupPids = new Set();
let root = rootArg || await readFile(ROOT_FILE, "utf8").then((text) => text.trim()).catch(() => "");
let stopping = false;

function log(message) {
  console.log(`[start] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[start] ${message}`);
  process.exitCode = code;
}

function parsePort(value, fallback, name, max = 65535) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > max) {
    throw new Error(`${name} 必须是 1024–${max} 之间的端口`);
  }
  return port;
}

function spawnChild(command, childArgs, options = {}) {
  const {
    stdio = "inherit",
    label = command,
    stopOnExit = false,
    shell = process.platform === "win32" && /\.cmd$/i.test(command),
  } = options;
  const child = spawn(command, childArgs, {
    cwd: PROJECT,
    stdio,
    windowsHide: false,
    shell,
    detached: process.platform !== "win32",
  });
  children.add(child);
  if (child.pid) cleanupPids.add(child.pid);
  const stopForFailure = (message, code = 1) => {
    if (stopping) return;
    fail(message, code);
    void shutdown(code);
  };
  child.once("error", (error) => {
    if (stopOnExit) stopForFailure(`${label} 启动失败：${error.message}`);
  });
  child.once("exit", (code, signal) => {
    if (!stopOnExit || stopping) {
      children.delete(child);
      if (child.pid) cleanupPids.delete(child.pid);
      return;
    }
    const suffix = signal ? `（${signal}）` : `（代码 ${code ?? "未知"}）`;
    stopForFailure(`${label} 已退出${suffix}`, 1);
  });
  return child;
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
    child.once("error", (error) => done({ code: 1, error }));
    child.once("exit", (code, signal) => done({ code: code ?? 1, signal }));
  });
}

function portAvailable(port) {
  return new Promise((resolvePort) => {
    const probe = createProbe();
    const finish = (available) => {
      probe.removeAllListeners();
      resolvePort(available);
    };
    probe.once("error", () => finish(false));
    probe.once("listening", () => probe.close(() => finish(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function freePort(preferred, span = 1) {
  const last = 65535 - span + 1;
  for (let port = preferred; port <= last; port++) {
    const available = await Promise.all(
      Array.from({ length: span }, (_, offset) => portAvailable(port + offset)),
    );
    if (available.every(Boolean)) return port;
  }
  throw new Error(`没有可用端口：${preferred}-${Math.min(65535, preferred + 39)}`);
}

async function waitFor(url, predicate = (response) => response.ok, timeout = 30000) {
  const started = Date.now();
  while (!stopping && Date.now() - started < timeout) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (await predicate(response)) return response;
    } catch {
      // The service may still be starting or restarting its control socket.
    }
    if (stopping) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(stopping ? "启动已停止" : `等待超时：${url}`);
}

async function stopPidTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise((done) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => done());
      killer.once("error", () => done());
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* the process may already have exited */
      }
    }
  }
}

async function stopChildTree(child) {
  if (!child || !child.pid) return;
  if (process.platform !== "win32" && (child.killed || child.exitCode !== null)) return;
  await stopPidTree(child.pid);
}

async function shutdown(code = process.exitCode ?? 0) {
  if (stopping) return;
  stopping = true;
  if (code !== 0) process.exitCode = code;
  log("正在停止网页服务与音乐桥接…");
  const pids = new Set(cleanupPids);
  await Promise.all([
    ...[...children].map(stopChildTree),
    ...[...pids].map(stopPidTree),
  ]);
  children.clear();
  cleanupPids.clear();
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
if (process.platform !== "win32") process.once("SIGHUP", () => void shutdown(0));

function vlcExecutableAvailable() {
  const candidates = [];
  if (vlcArg) candidates.push(resolve(vlcArg));
  try {
    const pointer = JSON.parse(readFileSync(join(PROJECT, ".tools", "vlc-location.json"), "utf8"));
    if (pointer?.exe) candidates.push(resolve(pointer.exe));
  } catch {
    /* no pointer */
  }
  candidates.push(
    join(PROJECT, ".tools", "vlc", "vlc.exe"),
    "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe",
  );
  return candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

async function chooseRoot() {
  if (root || noMusic) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("音乐目录（直接回车则只启动网页）：");
    root = answer.trim();
  } finally {
    prompt.close();
  }
}

try {
  const unknownFlag = args.find((value) => {
    if (!value.startsWith("--")) return false;
    const name = value.split("=", 1)[0];
    return !valueFlags.has(name) && !booleanFlags.has(name);
  });
  if (unknownFlag) throw new Error(`未知启动参数：${unknownFlag}`);
  if (bridgeOnly && noMusic) throw new Error("--bridge-only 不能与 --no-music 同时使用");
  if (args.includes("--root") && !valueAfter("--root")) throw new Error("--root 后需要提供音乐目录");
  for (const name of ["--port", "--bridge-port", "--web-port", "--token", "--vlc", "--aout"]) {
    if (args.includes(name) && !valueAfter(name)) throw new Error(`${name} 后需要提供参数`);
  }

  const preferredBridgePort = parsePort(bridgePortArg, 8788, "bridge 端口", 65533);
  const preferredWebPort = parsePort(webPortArg, 5173, "网页端口");
  if (tokenArg !== undefined && !tokenArg.trim()) throw new Error("--token 不能是空值");

  if (!existsSync(join(PROJECT, "node_modules"))) {
    log("首次运行，正在安装依赖…");
    const install = spawnChild(NPM, ["ci"], { label: "npm ci" });
    const result = await waitForExit(install);
    if (result.code !== 0) throw new Error("npm ci 失败");
  }

  await chooseRoot();
  if (bridgeOnly && !root) {
    throw new Error('请指定音乐目录，例如：启动音乐服务.cmd "D:\\Music"');
  }
  if (root) {
    root = resolve(root);
    const isDirectory = existsSync(root) && statSync(root).isDirectory();
    if (!isDirectory && (explicitRoot || bridgeOnly)) throw new Error(`音乐目录不存在或不是文件夹：${root}`);
    if (!isDirectory) {
      log(`已记忆的音乐目录不可用，将仅启动网页：${root}`);
      root = "";
    }
  }

  let bridgePort = null;
  let token = null;
  if (!noMusic && root) {
    bridgePort = await freePort(preferredBridgePort, 3);
    token = tokenArg?.trim() || randomUUID().replace(/-/g, "").slice(0, 24);
    await mkdir(join(PROJECT, ".tools"), { recursive: true });
    await writeFile(ROOT_FILE, root, "utf8");

    if (vlcArg) {
      const explicitVlcPath = resolve(vlcArg);
      if (!existsSync(explicitVlcPath) || !statSync(explicitVlcPath).isFile()) {
        throw new Error(`指定的 VLC 不存在或不是文件：${explicitVlcPath}`);
      }
    }
    if (!vlcArg && !vlcExecutableAvailable()) {
      log("未找到可用的 VLC，正在获取…");
      const fetched = spawnChild(NODE, ["scripts/fetch-vlc.mjs"], { label: "VLC 获取" });
      const result = await waitForExit(fetched);
      if (result.code !== 0) throw new Error("VLC 获取失败");
    }

    const bridgeArgs = [
      "--experimental-strip-types",
      BRIDGE_SCRIPT,
      "--root",
      root,
      "--port",
      String(bridgePort),
      "--token",
      token,
    ];
    if (vlcArg) bridgeArgs.push("--vlc", vlcArg);
    if (aoutArg) bridgeArgs.push("--aout", aoutArg);
    if (hasFlag("--verbose")) bridgeArgs.push("--verbose");
    const bridge = spawnChild(NODE, bridgeArgs, { label: "VLC bridge", stopOnExit: true });
    const healthUrl = `http://127.0.0.1:${bridgePort}/api/health`;
    let bridgeHealth = null;
    await waitFor(healthUrl, async (response) => {
      if (!response.ok) return false;
      bridgeHealth = await response.json();
      return bridgeHealth.ready === true;
    }, 120000);
    if (Number.isInteger(bridgeHealth?.vlc?.pid) && bridgeHealth.vlc.pid > 0) {
      cleanupPids.add(bridgeHealth.vlc.pid);
    }
    log(`VLC bridge 已就绪：127.0.0.1:${bridgePort}`);
    // Keep the child referenced until shutdown; the exit handler owns failure cleanup.
    void bridge;
  } else if (!noMusic) {
    log("未找到音乐目录，将仅启动网页。可用 --root \"D:\\Music\" 启用 VLC 桥接。");
  }

  if (bridgeOnly) {
    log("音乐桥接正在前台运行，按 Ctrl+C 停止。");
    await new Promise(() => {});
  }

  const devPort = await freePort(preferredWebPort);
  const vite = spawnChild(
    NPM,
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(devPort), "--strictPort"],
    { label: "网页服务", stopOnExit: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const readVite = (chunk) => process.stdout.write(chunk);
  vite.stdout.on("data", readVite);
  vite.stderr.on("data", readVite);
  await waitFor(`http://127.0.0.1:${devPort}/`, (response) => response.ok, 30000);

  const query = new URLSearchParams(
    bridgePort
      ? {
          "rhine-bridge-port": String(bridgePort),
          "rhine-bridge-token": token,
          "rhine-music-engine": "vlc",
        }
      : {},
  );
  const queryString = query.toString();
  const url = `http://127.0.0.1:${devPort}/${queryString ? `?${queryString}` : ""}`;
  log(`网页已启动：http://127.0.0.1:${devPort}/`);
  if (bridgePort) log("VLC bridge 将由网页自动接入。");
  if (noOpen) log(`网页地址（仅本次启动）：${url}`);
  if (!noOpen) {
    const opener = process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
    const openerProcess = spawn(opener, [url], { stdio: "ignore", windowsHide: true });
    openerProcess.once("error", (error) => log(`无法自动打开浏览器：${error.message}；请手动访问 ${url}`));
  }
  log("关闭此窗口将停止网页与 VLC bridge。");
  await new Promise(() => {});
} catch (error) {
  if (!stopping) {
    fail(error instanceof Error ? error.message : String(error));
    await shutdown(1);
  }
}
