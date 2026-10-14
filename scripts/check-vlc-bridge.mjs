// VLC bridge protocol checks — no browser required.
//
// Starts scripts/vlc-bridge.mjs against a temporary music folder, then exercises
// the loopback API: token enforcement, catalogue, playback, transport, and the
// PCM tap that feeds the archive music reaction.
//
// Usage: node scripts/check-vlc-bridge.mjs [--root <dir>]
// Without --root a temporary folder with generated tones is used.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { stopProcessTree } from "./lib/owned-process.mjs";
import { LOCAL_ROOT, resetLocalDirectory, removeLocalDirectory } from "./lib/workspace-paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8899;
const TOKEN = "check-token";
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const musicRoot = rootIndex >= 0 ? args[rootIndex + 1] : join(LOCAL_ROOT, "fixtures", `bridge-check-run-${process.pid}`);
const temporary = rootIndex < 0;
const playlistRoot = join(LOCAL_ROOT, "fixtures", `bridge-playlists-run-${process.pid}`);
const headlessAudio = process.env.RHINE_VLC_AOUT === "dummy";
if (headlessAudio) console.log("# dummy audio output: physical volume checks require a real-output run");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { authorization: `Bearer ${TOKEN}` };
const base = `http://127.0.0.1:${PORT}`;

async function sineWav(seconds, hz, sampleRate = 44100) {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 0.85 * 32767);
    data.writeInt16LE(value, i * 4);
    data.writeInt16LE(value, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function mp3WithCover() {
  const frame = (id, payload) =>
    Buffer.concat([Buffer.from(id, "ascii"), (() => { const h = Buffer.alloc(6); h.writeUInt32BE(payload.length, 0); return h; })(), payload]);
  const text3 = (id, value) => frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x11)]);
  const apic = frame("APIC", Buffer.concat([Buffer.from([3]), Buffer.from("image/jpeg", "ascii"), Buffer.from([0, 3, 0]), jpeg]));
  const frames = Buffer.concat([
    text3("TIT2", "封面测试"),
    text3("TPE1", "桥接艺术家"),
    text3("TALB", "桥接专辑"),
    text3("TYER", "2024"),
    text3("TCON", "Electronic"),
    text3("TPOS", "1/1"),
    apic,
  ]);
  const syncsafe = (n) => Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
  return Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.from([3, 0, 0]), syncsafe(frames.length), frames, Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(3000, 0x20)]);
}

if (temporary) {
  await resetLocalDirectory(musicRoot);
  await mkdir(join(musicRoot, "tones"), { recursive: true });
  await writeFile(join(musicRoot, "tones", "01 低频 60Hz.wav"), await sineWav(8, 60));
  await writeFile(join(musicRoot, "tones", "02 高频 6kHz.wav"), await sineWav(8, 6000));
  await writeFile(join(musicRoot, "tones", "03 封面测试.mp3"), mp3WithCover());
  console.log(`# generated ${musicRoot}`);
}

const bridge = spawn(process.execPath, [
  "--experimental-strip-types", join(ROOT, "scripts", "vlc-bridge.mjs"),
  "--root", musicRoot, "--port", String(PORT), "--token", TOKEN,
  "--no-save-playlist",
  ...(process.env.RHINE_VLC_AOUT ? ["--aout", process.env.RHINE_VLC_AOUT] : []),
], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
bridge.stdout.on("data", (chunk) => (log += chunk));
bridge.stderr.on("data", (chunk) => (log += chunk));

const request = async (path, headers = auth) => {
  const response = await fetch(base + path, { headers });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
};
const playlistRequest = async (body, headers = auth) => {
  const response = await fetch(`${base}/api/playlist`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok  ${name}`);
};

try {
  let health = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    try {
      health = await (await fetch(`${base}/api/health`)).json();
      if (health.ready) break;
    } catch {
      /* still starting */
    }
  }
  assert.ok(health?.ready, `桥接未就绪：${log.split("\n").slice(-4).join(" | ")}`);
  assert.ok(health.vlc?.version, "VLC 未启动");
  await step(`桥接就绪（VLC ${health.vlc.version} · ${health.tracks} 首）`, async () => {});

  await step("未携带令牌的请求被拒绝", async () => {
    const denied = await request("/api/library", {});
    assert.equal(denied.status, 401);
  });

  await step("曲库包含生成的测试音", async () => {
    const library = await request("/api/library");
    assert.equal(library.status, 200);
    assert.ok(library.body.tracks.length >= 2, "曲目数量不足");
    assert.ok(library.body.tracks.some((track) => /低频/.test(track.name)), "中文文件名未解析");
  });

  await step("封面与年份流派透传（/api/library + /api/cover）", async () => {
    const library = await request("/api/library");
    const covered = library.body.tracks.find((track) => /封面测试/.test(track.name));
    assert.ok(covered, "封面测试曲未入库");
    assert.ok(covered.hasCover === true, "hasCover 未标记");
    assert.equal(covered.year, "2024", "year 未透传");
    assert.equal(covered.genre, "Electronic", "genre 未透传");
    assert.equal(covered.disc, 1, "disc 未透传");
    const plain = library.body.tracks.find((track) => /低频/.test(track.name));
    assert.ok(plain && plain.hasCover === false, "无封面曲目误标 hasCover");
    const bad = await request("/api/cover?id=nothex");
    assert.equal(bad.status, 400, "非法 id 未拒绝");
    const response = await fetch(`${base}/api/cover?id=${covered.id}`, { headers: auth });
    assert.equal(response.status, 200, "封面取回失败");
    assert.match(response.headers.get("content-type") ?? "", /image\/jpeg/, "封面 content-type 不符");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length >= 64 && bytes[0] === 0xff && bytes[1] === 0xd8, "封面字节内容不符");
    const denied = await fetch(`${base}/api/cover?id=${covered.id}`);
    assert.equal(denied.status, 401, "封面端点未鉴权");
  });

  const library = await request("/api/library");
  const low = library.body.tracks.find((track) => /低频/.test(track.name));
  await step("静默准备与一次性开始票据（鉴权、曲目边界、起点保持）", async () => {
    assert.equal((await request(`/api/prepare?id=${low.id}`, {})).status, 401);
    assert.equal((await request("/api/prepare?id=not-scanned")).status, 400);
    const prepared = await request(`/api/prepare?id=${low.id}&client=native-check&sequence=1`);
    assert.equal(prepared.status, 200); assert.equal(prepared.body.ready, true);
    await sleep(900);
    const held = (await request("/api/status")).body;
    assert.equal(held.state, "paused"); assert.equal(held.prepared, true);
    assert.ok(held.time <= 0.15, `准备期间不能推进播放起点: ${held.time}`);
    const bands = (await request("/api/bands")).body.bands;
    assert.ok(bands.every((value) => value === 0), "准备阶段不得发布播放频谱");
    await request("/api/volume?value=180");
    assert.equal((await request("/api/status")).body.volume, 180, "等待揭示期间修改的音量应保留");
    assert.equal((await request("/api/start?ticket=wrong&client=native-check&sequence=2")).status, 409);
    assert.equal((await request("/api/status")).body.prepared, true, "错误票据不能取消有效准备");
    const again = await request(`/api/prepare?id=${low.id}&client=native-check&sequence=3`);
    assert.equal(again.status, 200);
    assert.equal((await request(`/api/start?ticket=${again.body.ticket}&client=native-check&sequence=4`)).status, 200);
    assert.equal((await request(`/api/start?ticket=${again.body.ticket}&client=native-check&sequence=5`)).status, 409);
    const playing = (await request("/api/status")).body;
    assert.equal(playing.state, "playing", "重复票据不能中断已经开始的歌曲");
    // VLC's dummy output has no volume callback. Real-output runs still check
    // the applied volume; preparation above always checks the user's intent.
    if (headlessAudio) console.log("# SKIP applied playback volume: dummy output has no physical volume callback");
    else assert.equal(playing.volume, 180);
    await request("/api/stop");
  });
  await step("停止使旧准备序号及开始票据失效，恢复用户音量", async () => {
    const pending = request(`/api/prepare?id=${low.id}&client=cancellation-check&sequence=1`);
    await sleep(10);
    const stopped = await request("/api/stop?client=cancellation-check&sequence=2");
    assert.equal(stopped.status, 200);
    const result = await pending;
    assert.ok(result.status === 200 || result.status === 409, `旧准备意外返回 ${result.status}`);
    if (result.status === 200) assert.equal((await request(`/api/start?ticket=${result.body.ticket}&client=cancellation-check&sequence=3`)).status, 409);
    assert.equal((await request(`/api/prepare?id=${low.id}&client=cancellation-check&sequence=1`)).status, 409);
    await sleep(400);
    const state = (await request("/api/status")).body;
    assert.equal(state.state, "stopped");
    assert.equal(state.currentId, null);
    assert.equal(state.prepared, false);
    if (headlessAudio) console.log("# SKIP restored output volume: dummy output has no physical volume callback");
    else assert.equal(state.volume, 180);
    await request("/api/volume?value=256");
  });
  await step(`通过 VLC 播放 ${low.name}`, async () => {
    const play = await request(`/api/play?id=${encodeURIComponent(low.id)}`);
    assert.equal(play.status, 200);
    let status = null;
    for (let i = 0; i < 40; i++) {
      await sleep(750);
      status = (await request("/api/status")).body;
      if (status.state === "playing" && status.time > 0.3) break;
    }
    assert.equal(status?.state, "playing", `播放未开始（${status?.state}）`);
    assert.ok(status.length > 0, "时长未知");
  });

  await step("PCM 旁路输出的频谱落在低频段", async () => {
    let bands = null;
    for (let i = 0; i < 30; i++) {
      await sleep(700);
      bands = (await request("/api/bands")).body.bands;
      const low8 = bands.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
      if (low8 > 0.05) break;
    }
    const low8 = bands.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
    const high32 = bands.slice(32, 64).reduce((a, b) => a + b, 0) / 32;
    assert.ok(low8 > 0.05, `低频能量不足：${low8.toFixed(3)}`);
    assert.ok(low8 > high32, `低频段未占优：low ${low8.toFixed(3)} vs high ${high32.toFixed(3)}`);
  });

  await step("频谱 SSE 持续推送", async () => {
    const response = await fetch(`${base}/api/spectrum?token=${TOKEN}`, { headers: auth });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let frames = 0;
    const deadline = Date.now() + 6000;
    while (frames < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      frames += decoder.decode(value).split("data: ").length - 1;
    }
    await reader.cancel().catch(() => {});
    assert.ok(frames >= 2, `SSE 帧不足：${frames}`);
  });

  await step("定位与暂停生效", async () => {
    const seek = await request("/api/seek?seconds=4");
    assert.equal(seek.status, 200);
    await sleep(1200);
    const seeked = (await request("/api/status")).body;
    assert.ok(seeked.time >= 3, `定位未生效：${seeked.time}`);
    await request("/api/pause");
    await sleep(1200);
    const paused = (await request("/api/status")).body;
    assert.equal(paused.state, "paused", `暂停未生效：${paused.state}`);
    await request("/api/resume");
    await sleep(500);
    const resumed = (await request("/api/status")).body;
    assert.equal(resumed.state, "playing");
    assert.ok(resumed.time >= paused.time, `恢复应延续位置: ${paused.time} -> ${resumed.time}`);
    await request("/api/stop");
  });

  await step("歌单切换端点鉴权与请求边界", async () => {
    assert.equal((await playlistRequest({ root: musicRoot }, {})).status, 401);
    assert.equal((await request("/api/playlist")).status, 405);
    assert.equal((await playlistRequest({ root: musicRoot, part: -1 })).status, 400);
    assert.equal((await playlistRequest({ root: musicRoot, split: "yes" })).status, 400);
    const before = (await request("/api/library")).body;
    assert.equal((await playlistRequest({ root: join(playlistRoot, "absent") })).status, 400);
    assert.deepEqual((await request("/api/library")).body.tracks, before.tracks);
  });

  if (temporary) await step("超限保留旧歌单，接受分卷后停止旧准备并只加载当前1000首", async () => {
    await resetLocalDirectory(playlistRoot);
    const sample = mp3WithCover();
    for (let first = 0; first < 1001; first += 50)
      await Promise.all(Array.from({ length: Math.min(50, 1001 - first) }, (_, index) => writeFile(join(playlistRoot, `${String(first + index).padStart(4, "0")}.mp3`), sample)));
    const pending = await request(`/api/prepare?id=${low.id}&client=playlist-check&sequence=1`);
    assert.equal(pending.status, 200);
    const denied = await playlistRequest({ root: playlistRoot });
    assert.equal(denied.status, 409); assert.equal(denied.body.error, "playlist_limit"); assert.equal(denied.body.total, 1001); assert.equal(denied.body.parts, 2);
    assert.equal((await request("/api/status")).body.prepared, true, "拒绝超限不能清除旧准备");
    assert.equal((await request("/api/library")).body.root, library.body.root);
    const switching = playlistRequest({ root: playlistRoot, part: 0, split: true });
    let scanning = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const health = (await request("/api/health")).body;
      if (health.scan.phase === "reading") { scanning = true; break; }
      await sleep(10);
    }
    assert.equal(scanning, true, "没有观察到生成曲库的扫描阶段");
    assert.equal((await request("/api/scan")).status, 409, "切换期间不能把旧目录重扫排到新歌单之后");
    const first = await switching;
    assert.equal(first.status, 200); assert.equal(first.body.tracks.length, 1000); assert.equal(first.body.playlist.part, 0); assert.equal(first.body.playlist.split, true);
    assert.equal((await request(`/api/start?ticket=${pending.body.ticket}`)).status, 409);
    assert.equal((await request(`/api/play?id=${low.id}`)).status, 400);
    assert.equal((await request("/api/status")).body.currentId, null);
    assert.equal((await playlistRequest({ root: playlistRoot, part: 2, split: true })).status, 409);
    assert.equal((await request("/api/library")).body.tracks.length, 1000);
    const second = await playlistRequest({ root: playlistRoot, part: 1, split: true });
    assert.equal(second.status, 200); assert.equal(second.body.tracks.length, 1); assert.equal(second.body.tracks[0].name, "1000.mp3");
    const restored = await playlistRequest({ root: musicRoot });
    assert.equal(restored.status, 200); assert.equal(restored.body.tracks.length, library.body.tracks.length);
    assert.equal((await request("/api/status")).body.state, "stopped");
  });

  console.log(`\n${passed} VLC bridge checks passed.`);
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  console.error(log.split("\n").slice(-8).join("\n"));
  process.exitCode = 1;
} finally {
  await stopProcessTree(bridge);
  await sleep(400);
  if (temporary && !existsSync(join(musicRoot, "keep"))) await removeLocalDirectory(musicRoot).catch(() => {});
  if (temporary) await removeLocalDirectory(playlistRoot).catch(() => {});
}
