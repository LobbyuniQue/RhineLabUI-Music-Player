import assert from "node:assert/strict";
import { test } from "node:test";
import { createNeteaseAccount, NeteaseAccountError } from "./lib/netease-account.mjs";

const favoriteId = "a".repeat(32), createdId = "b".repeat(32), songId = "c".repeat(32);
const profile = { id: "1".repeat(32), nickname: "Fixture", vipDetail: [{ type: 6, expireTime: 4102444800000 }],
  fullVipDetail: [{ type: 15, expireTime: 1 }], userToken: "DO_NOT_RETURN" };
const favorite = { id: favoriteId, originalId: 12, name: "Likes", trackCount: 31 };
const created = { id: createdId, originalId: 13, name: "Created", trackCount: 1 };
const song = { id: songId, originalId: 17, name: "Test song", artists: [{ name: "Artist" }], album: { name: "Album" },
  playFlag: true, plLevel: "lossless", maxBrLevel: "hires", dlLevel: "hires", userToken: "DO_NOT_RETURN" };
const good = value => ({ ok: true, stdout: JSON.stringify(value), stderr: "" });
const data = value => good({ code: 200, subCode: null, data: value });
const status = code => e => e instanceof NeteaseAccountError && e.status === code;

function fixture(options = {}) {
  const calls = [];
  const state = { profile, song, login: { success: true, message: "已登录" }, now: 1000, ...options };
  const service = createNeteaseAccount({ now: () => state.now, async run(args) {
    calls.push(args);
    if (state.hook) {
      const result = await state.hook(args);
      if (result) return result;
    }
    const command = args.slice(0, 2).join(" ");
    if (command === "login --check") return good(state.login);
    if (command === "login --background") return good({ success: true, url: state.loginUrl });
    if (command === "logout") { state.login = { success: false, message: "未登录" }; return good({ success: true }); }
    if (command === "user info") return data(state.profile);
    if (command === "user favorite") return data(favorite);
    if (command === "playlist created") return data({ records: [favorite, created], recordCount: 2 });
    if (command === "playlist tracks") {
      const id = args[args.indexOf("--playlistId") + 1], offset = Number(args[args.indexOf("--offset") + 1]);
      return data(Array.from({ length: id === createdId || offset === 30 ? 1 : 30 }, (_, i) => ({
        ...state.song, originalId: state.song.originalId + i + offset,
        id: i || offset ? (i + offset).toString(16).padStart(32, "0") : state.song.id,
      })));
    }
    assert.fail("Unexpected command " + args.join(" "));
  } });
  return { state, calls, service };
}

test("returns a confirmed login and active membership, without raw CLI credentials or expired tiers", async () => {
  const { service } = fixture();
  const result = await service.status();
  assert.equal(result.state, "signed-in");
  assert.equal(result.userName, "Fixture");
  assert.equal(result.membership.status, "active");
  assert.ok(!JSON.stringify(result).includes("DO_NOT_RETURN"));
  assert.deepEqual(result.membership.tiers.map(t => t.type), [6]);
});

test("distinguishes missing application keys, expired authorizations and an actual pending login", async () => {
  const { service, state } = fixture({ login: { success: false, message: "API key 未设置" } });
  assert.equal((await service.status()).state, "unconfigured");
  state.login = { success: false, message: "登录已过期" };
  assert.match((await service.status()).message, /过期/);
  state.loginUrl = "https://music.163.com/login?code=fixture";
  assert.equal((await service.login()).loginUrl, state.loginUrl);
  assert.equal((await service.status()).state, "pending");
  state.now += 121000;
  assert.equal((await service.status()).state, "signed-out");
  state.loginUrl = "https://example.org/authorize";
  const fallback = await service.login();
  assert.equal(fallback.loginUrl, undefined);
  assert.match(fallback.message, /npm run netease:login/);
});

test("lists the user's favourite only once and resolves real catalogued IDs to paginated track rows", async () => {
  const { service, calls } = fixture();
  assert.deepEqual((await service.playlists()).playlists, [
    { id: favoriteId, name: "Likes", kind: "liked" }, { id: createdId, name: "Created", kind: "created" },
  ]);
  const a = await service.tracks({ id: favoriteId });
  const b = await service.tracks({ id: favoriteId, offset: 30 });
  assert.equal(a.tracks.length, 30);
  assert.equal(a.hasMore, true);
  assert.equal(b.tracks.length, 1);
  assert.equal(b.hasMore, false);
  assert.deepEqual(a.tracks[0], { id: "17", encryptedId: songId, name: "Test song", artists: ["Artist"], album: "Album" });
  await assert.rejects(service.tracks({ id: "9".repeat(32) }), status(404));
  assert.ok(calls.filter(a => a[1] === "tracks").every(a => a.includes(favoriteId)));
  assert.equal((await service.tracks({ id: createdId })).tracks.length, 1);
});

test("resolves only freshly reported playable levels and keeps the selected preference per account and song", async () => {
  const { service, state } = fixture();
  await service.tracks({ id: createdId });
  let available = await service.quality({ id: songId });
  assert.equal(available.scope, "reported-maximum");
  assert.equal(available.availability, "available");
  assert.deepEqual(available.levels.map(l => l.id), ["lossless"]);
  assert.equal(available.selectedId, "");
  assert.equal((await service.quality({ id: songId, level: "lossless" })).selectedId, "lossless");
  assert.equal((await service.quality({ id: songId })).selectedId, "lossless");
  await assert.rejects(service.quality({ id: songId, level: "hires" }), status(400));
  assert.equal((await service.quality({ id: songId, level: "" })).selectedId, "");
  state.now += 300001;
  await assert.rejects(service.quality({ id: songId }), status(409));
  state.song = { ...song, playFlag: false };
  await service.tracks({ id: createdId });
  available = await service.quality({ id: songId });
  assert.deepEqual(available.levels, []);
  assert.equal(available.availability, "unavailable");
  state.song = { ...song, playFlag: undefined, plLevel: undefined };
  await service.tracks({ id: createdId });
  assert.equal((await service.quality({ id: songId })).availability, "unknown");
  state.profile = { ...profile, id: "2".repeat(32) };
  await assert.rejects(service.quality({ id: songId }), status(409));
});

test("a simulated official logout invalidates cached rights and late private results", async () => {
  const { service, state, calls } = fixture();
  await service.tracks({ id: createdId });
  let unblock, started;
  const waiting = new Promise(resolve => { started = resolve; });
  state.hook = async args => {
    if (args[0] === "playlist" && args[1] === "tracks") {
      started(); return new Promise(resolve => { unblock = () => resolve(data([song])); });
    }
  };
  const request = service.tracks({ id: createdId });
  await waiting;
  assert.equal((await service.logout()).state, "signed-out");
  unblock();
  await assert.rejects(request, status(409));
  assert.equal((await service.status()).state, "signed-out");
  assert.ok(calls.some(a => a.join(" ") === "logout"));
  assert.ok(!calls.some(a => a[0] === "play"));
});
