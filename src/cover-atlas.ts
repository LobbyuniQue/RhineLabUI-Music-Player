// Cover art atlas for the music archive array (2.0).
//
// One 2048×2048 canvas holds up to 256 cover tiles (128px each). Every card in
// the array samples its tile through a per-instance index; tiles are assigned
// stably per track and filled asynchronously as cover blobs decode. Tile 0 is
// the brand placeholder and doubles as the overflow fallback.

import * as THREE from "three";

export const ATLAS_SIZE = 2048;
export const ATLAS_TILE = 128;
export const ATLAS_GRID = ATLAS_SIZE / ATLAS_TILE;
export const ATLAS_COUNT = ATLAS_GRID * ATLAS_GRID;

export class CoverAtlas {
  readonly texture: THREE.CanvasTexture;
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private assigned = new Map<string, number>();
  private free: number[] = [];
  /** Tracks whose real art has been drawn into their tile. */
  readonly filled = new Set<string>();
  private dirty = false;

  constructor() {
    this.canvas.width = this.canvas.height = ATLAS_SIZE;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.fillStyle = "#1e211c";
    this.ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    this.drawPlaceholder(0);
    for (let tile = ATLAS_COUNT - 1; tile >= 1; tile--) this.free.push(tile);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = true;
  }

  private rect(tile: number) {
    return { x: (tile % ATLAS_GRID) * ATLAS_TILE, y: Math.floor(tile / ATLAS_GRID) * ATLAS_TILE };
  }

  /** Brand-styled empty cover: warm paper, thin frame, glyph. */
  private drawPlaceholder(tile: number) {
    const { x, y } = this.rect(tile);
    const c = this.ctx;
    c.fillStyle = "#e6e2d9";
    c.fillRect(x, y, ATLAS_TILE, ATLAS_TILE);
    c.fillStyle = "#171713";
    c.fillRect(x + 6, y + 6, ATLAS_TILE - 12, 3);
    c.fillRect(x + 6, y + ATLAS_TILE - 9, ATLAS_TILE - 12, 2);
    c.fillStyle = "#878476";
    c.font = "52px MiSans";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("♪", x + ATLAS_TILE / 2, y + ATLAS_TILE / 2 + 4);
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
  }

  /** Stable tile for a track; placeholder content until fill() arrives. */
  tileFor(id: string): number {
    const existing = this.assigned.get(id);
    if (existing !== undefined) return existing;
    if (!this.free.length) return 0;
    const tile = this.free.pop()!;
    this.assigned.set(id, tile);
    this.drawPlaceholder(tile);
    this.dirty = true;
    return tile;
  }

  /** Draws decoded art into the track's tile, cover-cropped to a square. */
  fill(id: string, image: CanvasImageSource & { width: number; height: number }) {
    const tile = this.assigned.get(id);
    if (tile === undefined) return;
    const { x, y } = this.rect(tile);
    const side = Math.min(image.width, image.height) || 1;
    this.ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, x, y, ATLAS_TILE, ATLAS_TILE);
    this.filled.add(id);
    this.dirty = true;
  }

  /** Uploads pending tiles at most once per frame. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.texture.needsUpdate = true;
  }
}
