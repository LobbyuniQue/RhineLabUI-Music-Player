// Archive record source abstraction (2.0).
//
// The archive array used to read the build-time `data.ts` constants directly.
// The music archive mode needs the same shape at runtime: a set of columns
// (groups) and records assigned to them. Both the Rhine archive and the music
// library are expressed as an ArchiveView; the scene, the loop math and the
// UI read the *active* view, so switching modes is a data swap, not a rebuild.

import {
  records as rhineRecords,
  archiveColumns as rhineColumns,
  categories as rhineCategories,
  type ArchiveRecord,
} from "./data.ts";

export type { ArchiveRecord };

export interface ArchiveView {
  /** "archive" for the built-in Rhine archive, "music" for the local library. */
  kind: "archive" | "music";
  /** Group name per data column (lane → group). */
  columns: string[];
  /** Search filter options including the leading "全部档案" entry. */
  categories: string[];
  records: ArchiveRecord[];
  /** Record indices of a data column, in display order (precomputed). */
  columnFiles(lane: number): number[];
  /** Logical coordinates are independent of the visible instance pool. Slot
   * is an opaque record index, never a fixed-width lane/row encoding. */
  fileLocation(index: number): { lane: number; row: number; slot: number };
  fileAtSlot(slot: number): number;
  /** Stable backing id of a record (archive id / track id), used to keep the
   * selection across view rebuilds (grouping switch, rescan). */
  backingId(index: number): string;
}

/**
 * Packs records into columns. `laneOf` maps a record to its data column; the
 * per-column record lists preserve the incoming record order, which matches
 * the behaviour of the original `columnFiles` filter over `data.ts`.
 */
export function buildView(
  kind: ArchiveView["kind"],
  columns: string[],
  categories: string[] | undefined,
  records: ArchiveRecord[],
  laneOf: (record: ArchiveRecord) => number,
  backingId?: (index: number) => string,
): ArchiveView {
  const byColumn: number[][] = columns.map(() => []);
  const locations: { lane: number; row: number; slot: number }[] = [];
  records.forEach((record, index) => {
    const lane = laneOf(record);
    const files = byColumn[lane];
    locations[index] = { lane, row: 12 + (files?.length ?? 0), slot: index };
    if (files) files.push(index);
  });
  return {
    backingId: backingId ?? ((index) => records[index].id),
    kind,
    columns,
    categories: categories ?? ["全部档案", ...columns],
    records,
    columnFiles: (lane) => byColumn[lane] ?? [],
    fileLocation(index) {
      return locations[index] ?? { lane: 0, row: 12, slot: 0 };
    },
    fileAtSlot(slot) {
      return Number.isInteger(slot) && slot >= 0 && slot < records.length ? slot : 0;
    },
  };
}

/** The built-in Rhine archive retains its original column/row geometry. */
export const rhineView: ArchiveView = buildView(
  "archive",
  rhineColumns,
  rhineCategories,
  rhineRecords,
  (record) => rhineColumns.indexOf(record.category),
);

let active: ArchiveView = rhineView;
export function activeView(): ArchiveView {
  return active;
}
export function setActiveView(view: ArchiveView) {
  active = view;
}

/** Plain-text export of a record (mirrors scripts/archive-content.mjs). */
export function recordText(record: ArchiveRecord): string {
  return `RHINE LAB · INTERNAL DATABASE\r\n\r\n档案编号：${record.id}\r\n标题：${record.title}\r\n英文：${record.en}\r\n科室：${record.department}\r\n编目范围：${record.date}\r\n相关人物：${record.lead}\r\n访问范围：${record.clearance}\r\n\r\n摘要：\r\n${record.abstract}\r\n\r\n研究记录：\r\n${record.findings.map((finding, index) => `${index + 1}. ${finding}`).join("\r\n")}${record.source ? `\r\n\r\n参考链接：${record.source}` : ""}\r\n`;
}
