// Regression checks for large music groups and recyclable, asynchronous covers.
// Synthetic metadata and a canvas recorder need no browser or private music.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CoverAtlas, ATLAS_COUNT, ATLAS_TILE } from "../src/cover-atlas.ts";
import { rhineView, setActiveView } from "../src/archive-view.ts";
import { fileLocation as legacyLocation } from "../src/data.ts";
import { buildMusicView } from "../src/music-grouping.ts";
import { fileAtCell, selectionCell } from "../src/archive-loop.ts";
import { railFromRow, rowFromRail, ROW_SPACING_MIN, ROW_SPACING_MAX, MUSIC_ROW_SPACING_DEFAULT } from "../src/row-spacing.ts";

const tracks = [21, 65, 300].flatMap((size, group) =>
  Array.from({ length: size }, (_, index) => ({
    id: `group-${group}-track-${index}`,
    title: `Track ${index}`,
    name: `track-${index}.flac`,
    path: `group-${group}/track-${index}.flac`,
    album: `Album ${group}`,
    artist: "Synthetic Artist",
    track: index + 1,
    duration: 60,
    codec: "flac",
    genre: "",
    year: "",
    disc: null,
    tagged: true,
    hasCover: true,
    missing: false,
    size: 1,
    modified: 0,
  })),
);
const view = buildMusicView(tracks, "album");
setActiveView(view);
const slots = new Set();
for (let index = 0; index < view.records.length; index++) {
  const location = view.fileLocation(index);
  assert.equal(view.fileAtSlot(location.slot), index, `slot round trip for ${index}`);
  assert.equal(fileAtCell(location), index, `cell selects its actual track at ${location.lane}:${location.row}`);
  assert.equal(view.backingId(index), view.musicTracks[index].id);
  slots.add(location.slot);
  for (const spacing of [ROW_SPACING_MIN, MUSIC_ROW_SPACING_DEFAULT, ROW_SPACING_MAX]) {
    assert.ok(Math.abs(rowFromRail(railFromRow(location.row, spacing), spacing) - location.row) < 1e-9);
  }
}
assert.equal(slots.size, tracks.length, "rows beyond 31 never collide with another lane");
assert.equal(view.fileLocation(20).row, 32, "the first former 32-slot overflow is covered");
assert.equal(view.fileLocation(tracks.length - 1).row, 311);
const regrouped = buildMusicView(tracks.map((track, index) => ({
  ...track, artist: index % 2 ? "Artist Z" : "Artist A",
})), "artist");
for (const oldIndex of [20, 65, tracks.length - 1]) {
  const id = view.backingId(oldIndex);
  const nextIndex = regrouped.records.findIndex((_, index) => regrouped.backingId(index) === id);
  const next = regrouped.fileLocation(nextIndex);
  assert.equal(regrouped.musicTracks[nextIndex].id, id, "a regrouped selection resolves its stable track id");
  assert.equal(regrouped.fileAtSlot(next.slot), nextIndex);
}
for (let lane = 0; lane < view.columns.length; lane++) {
  const members = view.columnFiles(lane);
  for (const direction of [-1, 1]) {
    let cell = { lane, row: 12 };
    let index = members[0];
    for (let step = 0; step < members.length * 3; step++) {
      index = members[(members.indexOf(index) + direction + members.length) % members.length];
      const next = selectionCell(index, cell, { axis: "row", direction });
      assert.equal(next.row - cell.row, direction, "seam traversal moves one physical row");
      assert.equal(fileAtCell(next), index, "long-group seam traversal resolves the requested track");
      cell = next;
    }
  }
}
setActiveView(rhineView);
for (let index = 0; index < rhineView.records.length; index++) {
  const { lane, row, slot } = rhineView.fileLocation(index);
  const old = legacyLocation(index);
  assert.deepEqual({ lane, row }, { lane: old.lane, row: old.row }, "built-in geometry stays unchanged");
  assert.equal(rhineView.fileAtSlot(slot), index);
}

const draws = [];
const context = { fillRect() {}, fillText() {}, drawImage(...args) { draws.push(args); } };
const previousDocument = globalThis.document;
globalThis.document = { createElement(type) {
  assert.equal(type, "canvas");
  return { width: 0, height: 0, getContext: () => context };
} };
try {
  const atlas = new CoverAtlas();
  const texture = atlas.texture;
  const image = { width: 4, height: 6 };
  const allIds = Array.from({ length: 1200 }, (_, index) => `cover-${index}`);
  let decoded = 0;
  for (let offset = 0; offset < allIds.length; offset += 37) {
    const visible = allIds.slice(offset, offset + 60);
    atlas.retain(visible);
    assert.equal(new Set(visible.map(id => atlas.tileFor(id))).size, visible.length);
    for (const id of visible) {
      assert.ok(atlas.tileFor(id) > 0, `${id} beyond the first 255 gets a real slot when visible`);
      assert.ok(atlas.fill(id, image, atlas.ticketFor(id)));
      decoded++;
    }
    assert.deepEqual([...atlas.filled].sort(), visible.slice().sort(), "offscreen art releases its cache entry");
  }
  assert.ok(decoded > 1200);
  const assertCrop = (draw, expected, message) => {
    draw.slice(1, 5).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, message));
  };
  assertCrop(draws[0], [0, 173 / 96, 4, 115 / 48], "portrait art is centered against the wide album cover area");
  assert.deepEqual(draws[0].slice(-2), [ATLAS_TILE, ATLAS_TILE]);
  atlas.retain(["wide-art"]);
  assert.ok(atlas.fill("wide-art", { width: 600, height: 100 }, atlas.ticketFor("wide-art")));
  const wide = draws.at(-1);
  assertCrop(wide, [(600 - 100 * 1536 / 920) / 2, 0, 100 * 1536 / 920, 100],
    "panoramic art crops the horizontal edges rather than stretching the image");
  assert.deepEqual(wide.slice(-2), [ATLAS_TILE, ATLAS_TILE], "the shader restores the album crop from its square atlas tile");

  // Pin the complete next frame before reading tiles. Existing visible art
  // cannot be evicted midway through the frame, even at the capacity boundary.
  const saturated = allIds.slice(0, ATLAS_COUNT);
  atlas.retain(saturated);
  const pinned = saturated.map(id => atlas.tileFor(id));
  assert.equal(pinned.filter(tile => tile > 0).length, ATLAS_COUNT - 1);
  assert.equal(new Set(pinned.filter(tile => tile > 0)).size, ATLAS_COUNT - 1);
  const repeated = saturated.map(id => atlas.tileFor(id));
  assert.deepEqual(repeated, pinned, "resolving later cards never changes earlier GPU indices");
  const overflow = saturated.find(id => atlas.tileFor(id) === 0);
  atlas.retain([overflow, ...saturated]);
  assert.ok(atlas.tileFor(overflow) > 0, "a newly prioritized cover displaces an outer-margin tile");
  atlas.retain([overflow]);
  assert.ok(atlas.tileFor(overflow) > 0, "overflow is temporary, not a permanent placeholder");

  atlas.retain(["same-track"]);
  const oldTicket = atlas.ticketFor("same-track");
  atlas.retain([]);
  atlas.retain(["same-track"]);
  const newTicket = atlas.ticketFor("same-track");
  assert.notEqual(newTicket, oldTicket, "a recycled id receives a new allocation ticket");
  const drawCount = draws.length;
  assert.equal(atlas.fill("same-track", image, oldTicket), false);
  assert.equal(draws.length, drawCount, "a late decode cannot overwrite a recycled tile");
  assert.equal(atlas.fill("same-track", image, newTicket), true);

  atlas.reset();
  assert.equal(atlas.texture, texture, "scene materials retain the same GPU texture on rescan");
  assert.equal(atlas.filled.size, 0);
  atlas.retain(["same-track"]);
  assert.equal(atlas.fill("same-track", image, newTicket), false, "same-id art from a previous scan is rejected");
  assert.equal(atlas.fill("same-track", image, atlas.ticketFor("same-track")), true);
  const version = texture.version;
  atlas.flush();
  assert.equal(texture.version, version + 1);
  atlas.flush();
  assert.equal(texture.version, version + 1, "one upload covers all decoded tiles in the frame");
  texture.dispose();
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
console.log("Archive/covers: 386 tracks in 21/65/300-row groups, 1200 scrolling covers, frame pins and stale decode rejection passed.");

// Load the real library while resolving its browser-style imports for Node.
const libraryFile = new URL("../src/music-library.ts", import.meta.url);
const librarySource = ts.transpileModule(readFileSync(libraryFile, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/from "(\.\/.+?)"/g, (_, name) =>
  `from "${new URL(`${name}.ts`, libraryFile).href}"`);
const { MusicLibrary } = await import(`data:text/javascript;base64,${Buffer.from(librarySource).toString("base64")}`);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const bridgeTrack = { ...tracks[0], id: "same-id", folder: "Album", name: "same.mp3" };
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
const revoked = [];
const urls = new Set();
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
URL.createObjectURL = (blob) => {
  const url = createObjectURL(blob);
  urls.add(url);
  return url;
};
URL.revokeObjectURL = (url) => {
  revoked.push(url);
  urls.delete(url);
  revokeObjectURL(url);
};
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
try {
  const library = new MusicLibrary();
  const old = deferred(), fresh = deferred();
  let requests = 0;
  library.bridgeCoverUrl = () => (++requests === 1 ? old : fresh).promise;
  library.useBridgeTracks([bridgeTrack], "Root A");
  const oldRequest = library.coverUrl(library.tracks[0]);
  library.useBridgeTracks([bridgeTrack], "Root B");
  const freshRequest = library.coverUrl(library.tracks[0]);
  assert.equal(requests, 2, "same-id root replacement starts a new cover request");
  const oldUrl = URL.createObjectURL(new Blob(["old bridge art"]));
  old.resolve(oldUrl);
  assert.equal(await oldRequest, null, "late art from the previous root is discarded");
  assert.ok(revoked.includes(oldUrl), "discarded art releases its object URL");
  const duplicateRequest = library.coverUrl(library.tracks[0]);
  assert.equal(requests, 2, "old completion cannot erase the newer in-flight request");
  const freshUrl = URL.createObjectURL(new Blob(["new bridge art"]));
  fresh.resolve(freshUrl);
  assert.equal(await freshRequest, freshUrl);
  assert.equal(await duplicateRequest, freshUrl);
  assert.equal(await library.coverUrl(library.tracks[0]), freshUrl, "current art is cached");

  library.bridgeCoverUrl = async () => {
    requests++;
    return URL.createObjectURL(new Blob(["rescanned bridge art"]));
  };
  library.useBridgeTracks([bridgeTrack], "Root B");
  assert.ok(revoked.includes(freshUrl), "same-root catalogue replacement also releases cached art");
  const rescannedUrl = await library.coverUrl(library.tracks[0]);
  assert.notEqual(rescannedUrl, freshUrl);
  assert.equal(await (await fetch(rescannedUrl)).text(), "rescanned bridge art");
  assert.equal(requests, 3);
  library.releaseCovers();

  // Exercise actual scanning, metadata picture extraction and MusicStore's
  // memory fallback with two revisions of a synthetic same-path MP3.
  const text = (value) => [...new TextEncoder().encode(value)];
  const mp3WithCover = (color, modified) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${color}"/></svg>`;
    const picture = [0, ...text("image/svg+xml"), 0, 3, 0, ...text(svg)];
    const frame = [...text("APIC"), 0, 0, 0, picture.length, 0, 0, ...picture];
    const syncsafe = [(frame.length >>> 21) & 127, (frame.length >>> 14) & 127, (frame.length >>> 7) & 127, frame.length & 127];
    const bytes = Uint8Array.from([...text("ID3"), 3, 0, 0, ...syncsafe, ...frame, 0xff, 0xfb, 0x90, 0, ...new Array(600).fill(0)]);
    return new File([bytes], "same-cover.mp3", { lastModified: modified });
  };
  const local = new MusicLibrary();
  local.useFiles([mp3WithCover("red", 1000)]);
  const firstScan = await local.scan(() => {});
  assert.equal(firstScan.phase, "done");
  assert.equal(firstScan.parsed, 1);
  assert.equal(local.tracks[0].hasCover, true);
  const firstUrl = await local.coverUrl(local.tracks[0]);
  assert.match(await (await fetch(firstUrl)).text(), /fill="red"/);

  local.useFiles([mp3WithCover("green", 2000)]);
  const secondScan = await local.scan(() => {});
  assert.equal(secondScan.phase, "done");
  assert.equal(secondScan.updated, 1, "same-path revision updates stored metadata and art");
  assert.ok(revoked.includes(firstUrl), "successful rescan invalidates the old cached URL");
  const secondUrl = await local.coverUrl(local.tracks[0]);
  assert.notEqual(secondUrl, firstUrl);
  assert.match(await (await fetch(secondUrl)).text(), /fill="green"/);
  assert.equal(await local.coverUrl(local.tracks[0]), secondUrl);

  const restored = await local.restore();
  assert.equal(restored, true);
  assert.ok(revoked.includes(secondUrl), "restoring a library invalidates previously decoded URLs");
  const restoredUrl = await local.coverUrl(local.tracks[0]);
  assert.notEqual(restoredUrl, secondUrl);
  assert.match(await (await fetch(restoredUrl)).text(), /fill="green"/);
  local.releaseCovers();
  assert.equal(urls.size, 0, "every real object URL created by the scenarios is released");
} finally {
  for (const url of urls) revokeObjectURL(url);
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else delete globalThis.window;
}
console.log("Library covers: same-id root/rescan/restore invalidation, stale URL release, in-flight deduplication and actual MP3 picture replacement passed.");
