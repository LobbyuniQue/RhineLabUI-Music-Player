import type { ArchiveRecord } from "./archive-view.ts";

export function musicLabelLines(record: Pick<ArchiveRecord, "en" | "title" | "department">) {
  const title = record.title.trim();
  const artist = record.en.trim();
  const album = record.department.trim();
  return {
    primary: title || artist || "未命名曲目",
    secondary: [artist, album].filter(Boolean).join(" · "),
  };
}
