import type { ArchiveRecord } from "./archive-view.ts";
import { musicLabelLines } from "./music-label.ts";

const WIDTH = 1536;
const HEIGHT = 1104;
const COVER_HEIGHT = 920;
const INK = "#171713";
const PAPER = "#eeeae1";
const MUTED = "#77756d";
const FONT = 'MiSans, "Microsoft YaHei", sans-serif';

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  let low = 0, high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(chars.slice(0, mid).join("") + "…").width <= width) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("") + "…";
}

function sourceSize(source: CanvasImageSource) {
  const image = source as unknown as Record<string, unknown>;
  for (const [widthKey, heightKey] of [
    ["naturalWidth", "naturalHeight"], ["videoWidth", "videoHeight"],
    ["displayWidth", "displayHeight"], ["width", "height"],
  ]) {
    const read = (value: unknown) => typeof value === "number" ? value
      : (value as { baseVal?: { value?: number } } | null)?.baseVal?.value ?? 0;
    const width = read(image[widthKey]), height = read(image[heightKey]);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };
  }
  return null;
}

function placeholder(ctx: CanvasRenderingContext2D, title: string) {
  const backdrop = ctx.createLinearGradient(0, 0, WIDTH, COVER_HEIGHT);
  backdrop.addColorStop(0, "#e2ddd1");
  backdrop.addColorStop(0.56, "#c6bdab");
  backdrop.addColorStop(1, "#9c9381");
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, WIDTH, COVER_HEIGHT);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, WIDTH, COVER_HEIGHT);
  ctx.clip();
  ctx.strokeStyle = "rgba(52, 47, 35, .18)";
  ctx.lineWidth = 1;
  for (let radius = 122; radius < 600; radius += 13) {
    ctx.beginPath();
    ctx.arc(1190, 420, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(238, 234, 225, .5)";
  ctx.beginPath();
  ctx.arc(1190, 420, 104, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(52, 47, 35, .35)";
  ctx.beginPath();
  ctx.arc(1190, 420, 15, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = `600 292px ${FONT}`;
  ctx.fillText(Array.from(title.trim())[0]?.toUpperCase() || "♪", 110, 556);
  ctx.font = `20px ${FONT}`;
  ctx.fillText("NO COVER ART", 124, 778);
  ctx.fillRect(124, 801, 160, 3);
  ctx.restore();
}

/** Album face: cover art dominates; the lower information band stays readable. */
export function drawAlbumLabel(
  ctx: CanvasRenderingContext2D,
  record: Pick<ArchiveRecord, "title" | "en" | "department" | "clearance">,
  index: number,
  cover: CanvasImageSource | null,
): void {
  const { width, height } = ctx.canvas;
  if (width <= 0 || height <= 0) return;
  ctx.save();
  try {
    const scaleX = width / WIDTH, scaleY = height / HEIGHT;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const lines = musicLabelLines(record);
    const size = cover && sourceSize(cover);
    let paintedCover = false;
    if (cover && size) {
      // Crop against the physical destination ratio, including resized canvases.
      const aspect = width / (height * COVER_HEIGHT / HEIGHT);
      const cropWidth = Math.min(size.width, size.height * aspect);
      const cropHeight = cropWidth / aspect;
      try {
        ctx.drawImage(cover, (size.width - cropWidth) / 2, (size.height - cropHeight) / 2,
          cropWidth, cropHeight, 0, 0, WIDTH, COVER_HEIGHT);
        paintedCover = true;
      } catch {
        // Images that have not decoded yet use the same missing-cover artwork.
      }
    }
    if (!paintedCover) placeholder(ctx, lines.primary);

    const shade = ctx.createLinearGradient(0, 0, 0, 140);
    shade.addColorStop(0, "rgba(0, 0, 0, .27)");
    shade.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, WIDTH, 140);
    ctx.fillStyle = "#fffdf6";
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText("RHINE AUDIO", 44, 58);
    ctx.fillRect(44, 73, 38, 2);

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, COVER_HEIGHT, WIDTH, HEIGHT - COVER_HEIGHT);
    ctx.fillStyle = "#b39870";
    ctx.fillRect(0, COVER_HEIGHT, WIDTH, 3);
    ctx.fillStyle = INK;
    ctx.font = `600 58px ${FONT}`;
    ctx.fillText(fitText(ctx, lines.primary, WIDTH - 88), 44, 993);
    ctx.fillStyle = MUTED;
    ctx.font = `28px ${FONT}`;
    ctx.fillText(fitText(ctx, lines.secondary || "未知艺术家", WIDTH - 88), 46, 1040);
    ctx.fillStyle = "#c9c2b5";
    ctx.fillRect(44, 1061, WIDTH - 88, 1);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FONT}`;
    ctx.fillText("ALBUM EDITION", 46, 1089);
    ctx.textAlign = "right";
    ctx.fillStyle = INK;
    ctx.font = `20px ${FONT}`;
    const number = String(Number.isFinite(index) ? Math.max(0, Math.trunc(index)) + 1 : 1).padStart(3, "0");
    const format = record.clearance.trim().toUpperCase() || "AUDIO";
    ctx.fillText(fitText(ctx, `M-${number}  /  ${format}`, 500), WIDTH - 44, 1089);
  } finally {
    ctx.restore();
  }
}
