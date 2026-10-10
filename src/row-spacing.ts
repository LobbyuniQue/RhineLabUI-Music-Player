import { ROW_SPACING } from "./archive-loop.ts";

export const MUSIC_ROW_SPACING_DEFAULT = 4.05;
export const ROW_SPACING_MIN = ROW_SPACING;
export const ROW_SPACING_MAX = 8;
const ROW_RAIL_OFFSET = -2.17;
const ROW_LOGICAL_CENTER = 15.5;

export function rowFromRail(value: number, spacing: number) {
  return (-value + ROW_RAIL_OFFSET) / spacing + ROW_LOGICAL_CENTER;
}

export function railFromRow(row: number, spacing: number) {
  return ROW_RAIL_OFFSET - (row - ROW_LOGICAL_CENTER) * spacing;
}

export function clampRowSpacing(value: number, fallback = MUSIC_ROW_SPACING_DEFAULT) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(ROW_SPACING_MAX, Math.max(ROW_SPACING_MIN, value));
}
