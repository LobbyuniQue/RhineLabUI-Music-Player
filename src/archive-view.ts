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
  records.forEach((record, index) => {
    const lane = laneOf(record);
    if (lane >= 0 && lane < columns.length) byColumn[lane].push(index);
  });
  return {
    backingId: backingId ?? ((index) => records[index].id),
    kind,
    columns,
    categories: categories ?? ["全部档案", ...columns],
    records,
    columnFiles: (lane) => byColumn[lane] ?? [],
    fileLocation(index) {
      const lane = laneOf(records[index]);
      const row = 12 + byColumn[lane].indexOf(index);
      return { lane, row, slot: lane * 32 + row };
    },
    fileAtSlot(slot) {
      const files = byColumn[Math.floor(slot / 32)] ?? [];
      if (!files.length) return 0;
      return files[Math.max(0, Math.min(files.length - 1, (slot % 32) - 12))];
    },
  };
}

/** The built-in Rhine archive, byte-identical to the original data.ts wiring. */
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
