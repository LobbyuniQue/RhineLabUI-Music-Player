import assert from "node:assert/strict";
import { drawAlbumLabel } from "../src/album-label.ts";

// A recording Canvas port executes the production painter without DOM or WebGL.
function canvas(width = 1536, height = 1104) {
  const calls = [], stack = [];
  const state = { font: "10px sans-serif", textAlign: "center", textBaseline: "top",
    fillStyle: "red", strokeStyle: "blue", globalAlpha: .4, globalCompositeOperation: "copy",
    lineWidth: 8, imageSmoothingEnabled: false, imageSmoothingQuality: "low", transform: [2, 0, 0, 2, 9, 11] };
  const ctx = { canvas: { width, height }, calls, stack, ...state,
    save() { stack.push(Object.fromEntries(Object.keys(state).map(key => [key, this[key]]))); calls.push({ op: "save" }); },
    restore() { Object.assign(this, stack.pop()); calls.push({ op: "restore" }); },
    setTransform(...args) { this.transform = args; calls.push({ op: "transform", args }); },
    measureText(text) {
      const size = parseFloat(this.font.match(/([\d.]+)px/)[1]);
      return { width: Array.from(text).reduce((sum, char) => sum + (/[\u2e80-\uffff]/.test(char) ? size : size * .6), 0) };
    },
    fillText(text, x, y) { calls.push({ op: "text", text, x, y, font: this.font, align: this.textAlign, width: this.measureText(text).width }); },
    fillRect(...args) { calls.push({ op: "rect", args, fill: this.fillStyle }); },
    drawImage(...args) { if (this.rejectImage) throw new Error("Image not decoded"); calls.push({ op: "image", args }); },
    createLinearGradient(...args) { const stops = []; calls.push({ op: "gradient", args, stops }); return { addColorStop: (...stop) => stops.push(stop) }; },
  };
  for (const name of ["beginPath", "rect", "clip", "arc", "stroke", "fill"]) ctx[name] = (...args) => calls.push({ op: name, args });
  return ctx;
}
const record = { title: "暗巷 Dark Alley", en: "HOYO-MiX", department: "观测室", clearance: "FLAC" };
const texts = ctx => ctx.calls.filter(call => call.op === "text");
const imageCall = ctx => ctx.calls.find(call => call.op === "image");
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} must equal ${b}`);
let passed = 0;
function check(name, work) { work(); console.log(`PASS ${name}`); passed++; }

check("Large artwork occupies 920/1104 of the face; metadata stays in the lower band", () => {
  const ctx = canvas();
  drawAlbumLabel(ctx, record, 2, { naturalWidth: 1000, naturalHeight: 1000 });
  assert.deepEqual(imageCall(ctx).args.slice(5), [0, 0, 1536, 920]);
  assert.ok(920 / 1104 > .83);
  const title = texts(ctx).find(call => call.text === record.title);
  assert.equal(title.y, 993);
  assert.match(title.font, /58px/);
  assert.ok(texts(ctx).find(call => call.text === "HOYO-MiX · 观测室").y > title.y);
  assert.ok(texts(ctx).find(call => call.text === "M-003  /  FLAC").y > 1061);
  assert.equal(texts(ctx).some(call => call.text.startsWith("NO.")), false);
});

check("Portrait and landscape sources use centered cover crops without stretching", () => {
  for (const [width, height] of [[400, 1200], [1920, 1080]]) {
    const ctx = canvas();
    drawAlbumLabel(ctx, record, 0, { naturalWidth: width, naturalHeight: height, width: 12, height: 8 });
    const [, sx, sy, sw, sh, , , dw, dh] = imageCall(ctx).args;
    near(sw / sh, dw / dh);
    near(sx, (width - sw) / 2);
    near(sy, (height - sh) / 2);
    assert.ok(sx >= 0 && sy >= 0 && sx + sw <= width && sy + sh <= height);
  }
});

check("Video, VideoFrame, canvas/bitmap and SVG sources use intrinsic sizes", () => {
  for (const image of [
    { videoWidth: 1920, videoHeight: 1080, width: 10, height: 10 },
    { displayWidth: 1920, displayHeight: 1080 },
    { width: 1920, height: 1080 },
    { width: { baseVal: { value: 1920 } }, height: { baseVal: { value: 1080 } } },
  ]) {
    const ctx = canvas();
    drawAlbumLabel(ctx, record, 0, image);
    const [, sx, sy, sw, sh] = imageCall(ctx).args;
    assert.ok(sw > 1000 && sh === 1080);
    near(sx, (1920 - sw) / 2);
    near(sy, 0);
  }
});

check("Resized faces adapt the canvas transform and preserve the physical image ratio", () => {
  for (const [width, height] of [[768, 552], [2048, 1024]]) {
    const ctx = canvas(width, height);
    drawAlbumLabel(ctx, record, 0, { width: 1200, height: 800 });
    assert.deepEqual(ctx.calls.find(call => call.op === "transform").args, [width / 1536, 0, 0, height / 1104, 0, 0]);
    const [, , , sw, sh] = imageCall(ctx).args;
    near(sw / sh, width / (height * 920 / 1104));
  }
});

check("Missing, invalid and undecoded covers draw the geometric fallback", () => {
  for (const image of [null, { width: 0, height: 0 }, { width: NaN, height: Infinity }, { width: 900, height: 600 }]) {
    const ctx = canvas();
    ctx.rejectImage = image?.width === 900;
    drawAlbumLabel(ctx, record, 0, image);
    assert.equal(imageCall(ctx), undefined);
    assert.ok(ctx.calls.filter(call => call.op === "arc").length > 20);
    assert.ok(texts(ctx).some(call => call.text === "NO COVER ART"));
    assert.ok(texts(ctx).some(call => call.text === "暗"));
  }
});

check("Long Chinese metadata is ellipsized within the information band", () => {
  const ctx = canvas();
  const title = "城市与星光之间的漫长旅途".repeat(20);
  drawAlbumLabel(ctx, { ...record, title, en: "歌手名字".repeat(40), department: "专辑名称".repeat(40) }, 999, null);
  for (const y of [993, 1040]) {
    const line = texts(ctx).find(call => call.y === y);
    assert.ok(line.text.endsWith("…"));
    assert.ok(line.width <= 1536 - 88);
  }
  assert.ok(texts(ctx).some(call => call.text === "M-1000  /  FLAC"));
});

check("Empty metadata and astral characters retain meaningful, unbroken labels", () => {
  const ctx = canvas();
  drawAlbumLabel(ctx, { title: " ", en: " ", department: " ", clearance: " " }, 0, null);
  assert.ok(texts(ctx).some(call => call.text === "未命名曲目"));
  assert.ok(texts(ctx).some(call => call.text === "未知艺术家"));
  assert.ok(texts(ctx).some(call => call.text === "M-001  /  AUDIO"));
  const emojiCtx = canvas();
  drawAlbumLabel(emojiCtx, { ...record, title: "🎵".repeat(200) }, 0, null);
  const title = texts(emojiCtx).find(call => call.y === 993).text;
  assert.ok(title.endsWith("…"));
  assert.equal(title.slice(0, -1).replaceAll("🎵", ""), "");
});

check("Painter restores caller state and tolerates an empty destination canvas", () => {
  const ctx = canvas();
  const before = { font: ctx.font, fill: ctx.fillStyle, align: ctx.textAlign, alpha: ctx.globalAlpha, transform: ctx.transform };
  drawAlbumLabel(ctx, record, 0, null);
  assert.equal(ctx.stack.length, 0);
  assert.deepEqual({ font: ctx.font, fill: ctx.fillStyle, align: ctx.textAlign, alpha: ctx.globalAlpha, transform: ctx.transform }, before);
  const empty = canvas(0, 0);
  drawAlbumLabel(empty, record, 0, null);
  assert.equal(empty.calls.length, 0);
});

console.log(`Album label: ${passed}/${passed} passed`);
