import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNeteaseMembership, normalizeNeteaseTrackQualities } from "./lib/netease-entitlements.mjs";

test("current membership distinguishes unknown from no active subscription", () => {
  assert.equal(normalizeNeteaseMembership(null).status, "unknown");
  assert.equal(normalizeNeteaseMembership({ fullVipDetail: [{ type: 15 }], redVipLevel: 8 }).status, "unknown");
  assert.equal(normalizeNeteaseMembership({ vipDetail: [], fullVipDetail: [{ type: 15 }] }).status, "none");
  assert.equal(normalizeNeteaseMembership({ vipDetail: [{}] }).status, "unknown");
  assert.equal(normalizeNeteaseMembership({ vipDetail: [{ type: true }] }).status, "unknown");
});

test("only effective tiers are displayed and SVIP has priority", () => {
  const expiry = 1806681599000;
  const profile = { vipDetail: [{ type: 13 }, { type: 6, expireTime: expiry }, { type: 15, expireTime: expiry }],
    fullVipDetail: [{ type: 17 }] };
  const result = normalizeNeteaseMembership(profile);
  assert.equal(result.status, "active");
  assert.equal(result.label, "黑胶 SVIP");
  assert.deepEqual(result.tiers.map(t => [t.type, t.expiresAt]), [[15, expiry], [6, expiry], [13, null]]);
});

test("only the highest level confirmed for this user and this track is selectable", () => {
  assert.deepEqual(normalizeNeteaseTrackQualities({ playFlag: true, visible: true, plLevel: "lossless",
    maxBrLevel: "sky", dlLevel: "hires", qualities: null }), [{ id: "lossless", label: "无损", playable: true }]);
  assert.deepEqual(normalizeNeteaseTrackQualities({ playFlag: true, plLevel: "standard" }),
    [{ id: "standard", label: "标准", playable: true }]);
});

test("resource capabilities, membership, stale bitrate and download access cannot grant playback", () => {
  for (const item of [null, { playFlag: false, plLevel: "hires" }, { visible: false, playFlag: true, plLevel: "sky" },
    { plLevel: "sky" }, { playFlag: true, plLevel: "none" }, { playFlag: true, redVipLevel: 6, maxBrLevel: "sky",
      userMaxBr: 320000, dlLevel: "lossless", qualities: { sqMusic: "lossless" } }]) {
    assert.deepEqual(normalizeNeteaseTrackQualities(item), []);
  }
});
