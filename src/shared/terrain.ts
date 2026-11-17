import { WORLD_W, WORLD_H, WATER_Y } from "./constants.ts";
import { rng } from "./rng.ts";

const EDGE = 60;

/** A one-byte-per-unit solidity mask: 1 = ground, 0 = air. */
export class Terrain {
  readonly data: Uint8Array;
  constructor(readonly w: number, readonly h: number, data?: Uint8Array) {
    this.data = data ?? new Uint8Array(w * h);
  }

  static flat(level: number, w = WORLD_W, h = WORLD_H): Terrain {
    const t = new Terrain(w, h);
    for (let y = level; y < h; y++) t.data.fill(1, y * w, y * w + w);
    return t;
  }

  static generate(seed: number, w = WORLD_W, h = WORLD_H): Terrain {
    const r = rng(seed * 7919 + 13);
    const t = new Terrain(w, h);
    const waves = Array.from({ length: 5 }, (_, i) => ({
      amp: (90 / (i + 1)) * (0.6 + r() * 0.8),
      freq: ((i + 1) * 1.3 + r()) / w,
      phase: r() * Math.PI * 2,
    }));
    const base = h * 0.52 + r() * 60;
    const surface = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      let y = base;
      for (const wv of waves) y += wv.amp * Math.sin(x * wv.freq * Math.PI * 2 + wv.phase);
      // taper the shoreline down into the water at both edges
      const e = Math.min(x - EDGE, w - EDGE - x);
      if (e < 140) y += (1 - Math.max(0, e) / 140) ** 2 * (WATER_Y + 40 - y);
      if (e < 0) y = h + 1;
      surface[x] = Math.max(230, y);
    }
    for (let x = 0; x < w; x++) {
      for (let y = Math.ceil(surface[x]); y < h; y++) t.data[y * w + x] = 1;
    }
    // floating ledges
    const ledges = 1 + Math.floor(r() * 2);
    for (let i = 0; i < ledges; i++) {
      const cx = w * (0.25 + r() * 0.5);
      const cy = surface[Math.floor(cx)] - 150 - r() * 60;
      const rx = 70 + r() * 50;
      const ry = 16 + r() * 8;
      t.fillEllipse(cx, Math.max(170, cy), rx, ry);
    }
    // caves and bites
    const caves = 4 + Math.floor(r() * 3);
    for (let i = 0; i < caves; i++) {
      const cx = EDGE + 150 + r() * (w - 2 * EDGE - 300);
      const cy = surface[Math.floor(cx)] + 50 + r() * 140;
      t.carve(cx, cy, 26 + r() * 30);
      t.carve(cx + 30 + r() * 30, cy + (r() - 0.5) * 30, 22 + r() * 20);
    }
    t.clearRect(0, 0, EDGE, h);
    t.clearRect(w - EDGE, 0, w, h);
    return t;
  }

  solid(x: number, y: number): boolean {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || xi >= this.w || yi < 0 || yi >= this.h) return false;
    return this.data[yi * this.w + xi] === 1;
  }

  carve(cx: number, cy: number, r: number): void {
    this.paintCircle(cx, cy, r, 0);
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number): void {
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = (y - cy) / ry;
      if (dy * dy > 1) continue;
      const half = rx * Math.sqrt(1 - dy * dy);
      const x0 = Math.max(0, Math.ceil(cx - half));
      const x1 = Math.min(this.w - 1, Math.floor(cx + half));
      if (x1 >= x0) this.data.fill(1, y * this.w + x0, y * this.w + x1 + 1);
    }
  }

  private paintCircle(cx: number, cy: number, r: number, v: 0 | 1): void {
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const d = r * r - dy * dy;
      if (d < 0) continue;
      const half = Math.sqrt(d);
      const x0 = Math.max(0, Math.ceil(cx - half));
      const x1 = Math.min(this.w - 1, Math.floor(cx + half));
      if (x1 >= x0) this.data.fill(v, y * this.w + x0, y * this.w + x1 + 1);
    }
  }

  clearRect(x0: number, y0: number, x1: number, y1: number): void {
    const xa = Math.max(0, Math.floor(x0));
    const xb = Math.min(this.w, Math.ceil(x1));
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++) {
      this.data.fill(0, y * this.w + xa, y * this.w + xb);
    }
  }

  /** First solid row at or below y in column x; h when none. */
  groundBelow(x: number, y: number): number {
    for (let yy = Math.max(0, Math.floor(y)); yy < this.h; yy++) if (this.solid(x, yy)) return yy;
    return this.h;
  }

  /** Outward surface normal estimated from the solid cells around (x, y). */
  normal(x: number, y: number): { x: number; y: number } {
    let sx = 0;
    let sy = 0;
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        if (dx * dx + dy * dy > 16) continue;
        if (this.solid(x + dx, y + dy)) {
          sx += dx;
          sy += dy;
        }
      }
    const len = Math.hypot(sx, sy);
    if (len < 1e-6) return { x: 0, y: -1 };
    return { x: -sx / len, y: -sy / len };
  }

  /** Column-major run lengths: per column, alternating air/solid run lengths, column end marked by -1. */
  toRLE(): number[] {
    const out: number[] = [];
    for (let x = 0; x < this.w; x++) {
      let cur = 0;
      let run = 0;
      for (let y = 0; y < this.h; y++) {
        const v = this.data[y * this.w + x];
        if (v === cur) run++;
        else {
          out.push(run);
          cur = v;
          run = 1;
        }
      }
      out.push(run, -1);
    }
    return out;
  }

  static fromRLE(w: number, h: number, rle: number[]): Terrain {
    const t = new Terrain(w, h);
    let x = 0;
    let y = 0;
    let cur = 0;
    for (const n of rle) {
      if (n === -1) {
        x++;
        y = 0;
        cur = 0;
        continue;
      }
      if (cur === 1) for (let i = 0; i < n; i++) t.data[(y + i) * w + x] = 1;
      y += n;
      cur ^= 1;
    }
    return t;
  }
}
