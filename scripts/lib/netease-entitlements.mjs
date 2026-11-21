// The user/profile/get/v2 endpoint publishes currently effective subscriptions
// in vipDetail. fullVipDetail additionally contains expired subscriptions.
const tierNames = new Map([[15, "黑胶 SVIP"], [6, "黑胶 VIP"], [1, "音乐包 / 畅听会员"],
  [13, "车载端会员"], [16, "手表端会员"], [17, "电视端会员"], [18, "音箱端会员"]]);
const qualityNames = new Map([
  ["standard", "标准"], ["higher", "较高"], ["exhigh", "极高"], ["lossless", "无损"],
  ["hires", "Hi-Res"], ["jyeffect", "高清臻音"], ["jymaster", "超清母带"],
  ["sky", "沉浸环绕声"], ["dolby", "杜比全景声"], ["jydolby", "杜比全景声"], ["vivid", "臻音全景声"],
]);
const unknownMember = () => ({ status: "unknown", label: "会员状态未知", tiers: [] });

export function normalizeNeteaseMembership(profile) {
  if (!Array.isArray(profile?.vipDetail)) return unknownMember();
  if (!profile.vipDetail.length) return { status: "none", label: "当前无生效会员", tiers: [] };
  const active = new Map();
  for (const entry of profile.vipDetail) {
    const type = entry?.type;
    if (!Number.isSafeInteger(type) || type <= 0) continue;
    const expiry = entry.expireTime;
    active.set(type, { type, label: tierNames.get(type) ?? `会员（类型 ${type}）`,
      expiresAt: Number.isSafeInteger(expiry) && expiry > 0 ? expiry : null });
  }
  if (!active.size) return unknownMember();
  const priority = [...tierNames.keys()];
  const rank = tier => priority.includes(tier.type) ? priority.indexOf(tier.type) : priority.length;
  const tiers = [...active.values()].sort((a, b) => rank(a) - rank(b));
  return { status: "active", label: tiers[0].label, tiers };
}

// In the authenticated playlist response plLevel is this user's maximum playable
// level for this track. maxBrLevel describes the recording, dlLevel is about
// downloads, and userMaxBr is deprecated. None of them fills a missing plLevel.
export function normalizeNeteaseTrackQualities(track) {
  const id = track?.plLevel;
  if (track?.visible === false || track?.playFlag !== true || !qualityNames.has(id)) return [];
  return [{ id, label: qualityNames.get(id), playable: true }];
}
