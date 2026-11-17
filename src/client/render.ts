import { WORLD_H, WORLD_W, WORM_R } from "../shared/constants.ts";
import type { GameEvent, ProjView, Seat, Snapshot, WormView } from "../shared/protocol.ts";
import { Terrain } from "../shared/terrain.ts";

/** Team colours, replaced in place when players pick theirs in the lobby. */
export const TEAM: [string, string] = ["#ff7a59", "#3fc8b6"];

const hash = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const STRATA: [number, number, number][] = [
  [110, 76, 60],
  [94, 64, 52],
  [124, 86, 66],
];

/** Paints the solidity mask into a textured offscreen canvas and repaints only the columns a crater touches. */
export class TerrainArt {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private scar: Uint8Array;
  private wave: Float32Array;

  constructor(readonly t: Terrain) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = t.w;
    this.canvas.height = t.h;
    this.ctx = this.canvas.getContext("2d")!;
    this.img = this.ctx.createImageData(t.w, t.h);
    this.scar = new Uint8Array(t.w * t.h);
    this.wave = new Float32Array(t.w);
    for (let x = 0; x < t.w; x++) this.wave[x] = 18 * Math.sin(x * 0.013) + 9 * Math.sin(x * 0.041 + 1.7);
    this.paint(0, t.w);
  }

  carve(x: number, y: number, r: number): void {
    this.t.carve(x, y, r);
    const R = r + 5;
    for (let yy = Math.max(0, Math.floor(y - R)); yy <= Math.min(this.t.h - 1, Math.ceil(y + R)); yy++)
      for (let xx = Math.max(0, Math.floor(x - R)); xx <= Math.min(this.t.w - 1, Math.ceil(x + R)); xx++) {
        const d = Math.hypot(xx - x, yy - y);
        if (d <= R) this.scar[yy * this.t.w + xx] = 1;
      }
    this.paint(Math.floor(x - R - 2), Math.ceil(x + R + 2));
  }

  private paint(x0: number, x1: number): void {
    const { w, h, data } = this.t;
    const px = this.img.data;
    x0 = Math.max(0, x0);
    x1 = Math.min(w, x1);
    for (let x = x0; x < x1; x++) {
      let depth = 0;
      let prevSolid = false;
      let airRun = 0;
      let open = true;
      const off = this.wave[x];
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        const o = i * 4;
        if (!data[i]) {
          px[o + 3] = 0;
          prevSolid = false;
          airRun++;
          continue;
        }
        if (!prevSolid) {
          // grass grows only where the ground faces open sky, not on cave floors
          open = airRun >= 120 || airRun === y;
          airRun = 0;
        }
        depth = prevSolid ? depth + 1 : 0;
        prevSolid = true;
        let r: number, g: number, b: number;
        const scar = this.scar[i] === 1;
        if (depth < 6 && !scar && open) {
          if (depth < 2) [r, g, b] = [184, 226, 128];
          else if (depth < 4) [r, g, b] = [143, 196, 106];
          else [r, g, b] = [96, 143, 74];
        } else if (depth < 3 && (scar || !open)) {
          [r, g, b] = depth === 0 ? [74, 48, 38] : [58, 38, 31];
        } else {
          const band = Math.floor((y + off) / 26);
          [r, g, b] = STRATA[((band % 3) + 3) % 3];
          const n = hash(x, y);
          const grain = (n - 0.5) * 16;
          r += grain;
          g += grain;
          b += grain;
          if (n > 0.996) {
            r += 34;
            g += 30;
            b += 26;
          }
          const shade = 1 - Math.min(0.38, depth / 900);
          r *= shade;
          g *= shade;
          b *= shade;
          const left = x > 0 && !data[i - 1];
          const right = x < w - 1 && !data[i + 1];
          const below = y < h - 1 && !data[i + w];
          if (left || right || below) {
            r *= 0.72;
            g *= 0.72;
            b *= 0.72;
          }
        }
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.img, 0, 0, x0, 0, x1 - x0, h);
  }
}

interface Particle {
  kind: "dirt" | "smoke" | "spark" | "ring" | "text" | "drop" | "line" | "flash";
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  text?: string;
  x2?: number;
  y2?: number;
}

export interface View {
  snap: Snapshot;
  worms: WormView[];
  proj: ProjView[];
  names: [string, string];
  /** the reader's seat (null for spectators) */
  seat: Seat | null;
  /** each player's aim; the reader's own is local so it never lags */
  aims: [number, number];
  /** each player's controlled worm */
  actives: [number, number];
  /** 0..1 power for the reader's own shot, null when they cannot act */
  power: number | null;
}

export class Renderer {
  readonly cam = { x: WORLD_W / 2, y: 520, zoom: 1 };
  art: TerrainArt | null = null;
  private ctx: CanvasRenderingContext2D;
  private vw = 0;
  private vh = 0;
  private dpr = 1;
  private particles: Particle[] = [];
  private shake = 0;
  private time = 0;
  private sky: HTMLCanvasElement | null = null;
  private halo: HTMLCanvasElement | null = null;
  private clouds = Array.from({ length: 7 }, (_, i) => ({ x: (i / 7) * (WORLD_W + 600) - 300, y: 80 + ((i * 53) % 160), s: 0.6 + ((i * 37) % 10) / 12 }));
  private stars = Array.from({ length: 70 }, (_, i) => ({ x: hash(i, 1), y: hash(i, 2) * 0.45, a: 0.25 + hash(i, 3) * 0.6 }));
  manualUntil = 0;
  autoZoom = true;
  wind = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
    this.canvas.width = Math.round(this.vw * this.dpr);
    this.canvas.height = Math.round(this.vh * this.dpr);
    this.sky = null;
    if (this.autoZoom) this.cam.zoom = this.defaultZoom();
  }

  defaultZoom(): number {
    return Math.max(0.42, Math.min(1.5, Math.min(this.vw / 980, this.vh / 520)));
  }

  setTerrain(t: Terrain): void {
    this.art = new TerrainArt(t);
    this.particles = [];
  }

  // ---------- coordinates ----------
  toScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.cam.x) * this.cam.zoom + this.vw / 2, y: (y - this.cam.y) * this.cam.zoom + this.vh / 2 };
  }
  toWorld(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.vw / 2) / this.cam.zoom + this.cam.x, y: (y - this.vh / 2) / this.cam.zoom + this.cam.y };
  }

  pan(dx: number, dy: number): void {
    this.cam.x -= dx / this.cam.zoom;
    this.cam.y -= dy / this.cam.zoom;
    this.manualUntil = performance.now() + 2600;
    this.clamp();
  }

  zoomAt(factor: number, sx: number, sy: number): void {
    const before = this.toWorld(sx, sy);
    this.cam.zoom = Math.max(0.3, Math.min(2.2, this.cam.zoom * factor));
    this.autoZoom = false;
    const after = this.toWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.manualUntil = performance.now() + 2600;
    this.clamp();
  }

  private clamp(): void {
    const hw = this.vw / 2 / this.cam.zoom;
    const hh = this.vh / 2 / this.cam.zoom;
    if (hw * 2 > WORLD_W + 300) this.cam.x = WORLD_W / 2;
    else this.cam.x = Math.max(hw - 150, Math.min(WORLD_W + 150 - hw, this.cam.x));
    this.cam.y = Math.max(-420 + hh, Math.min(WORLD_H + 30 - hh, this.cam.y));
  }

  follow(x: number, y: number, dt: number, rate = 3.5): void {
    if (performance.now() < this.manualUntil) return;
    const k = 1 - Math.exp(-dt * rate);
    this.cam.x += (x - this.cam.x) * k;
    this.cam.y += (y - 40 - this.cam.y) * k;
    this.clamp();
  }

  // ---------- events ----------
  onEvent(e: GameEvent, worms: WormView[]): void {
    switch (e.t) {
      case "boom": {
        this.art?.carve(e.x, e.y, e.r);
        this.shake = Math.max(this.shake, Math.min(14, e.r / 3));
        this.particles.push({ kind: "flash", x: e.x, y: e.y, vx: 0, vy: 0, life: 0.28, max: 0.28, size: e.r * 1.4, color: "#fff2c4" });
        this.particles.push({ kind: "ring", x: e.x, y: e.y, vx: 0, vy: 0, life: 0.45, max: 0.45, size: e.r * 1.25, color: "#ffd59a" });
        const n = 10 + Math.round(e.r / 2.5);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const s = 80 + Math.random() * 220;
          this.particles.push({ kind: "dirt", x: e.x, y: e.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, life: 0.8 + Math.random() * 0.6, max: 1.4, size: 1.5 + Math.random() * 2.5, color: Math.random() < 0.3 ? "#8fc46a" : "#6b4a3a" });
        }
        for (let i = 0; i < 6 + e.r / 8; i++) {
          this.particles.push({ kind: "smoke", x: e.x + (Math.random() - 0.5) * e.r, y: e.y + (Math.random() - 0.5) * e.r, vx: (Math.random() - 0.5) * 30, vy: -20 - Math.random() * 30, life: 1.4, max: 1.4, size: e.r * (0.3 + Math.random() * 0.3), color: "80,70,90" });
        }
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2;
          this.particles.push({ kind: "spark", x: e.x, y: e.y, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, life: 0.35, max: 0.35, size: 2, color: "#ffcf6b" });
        }
        break;
      }
      case "hurt": {
        const w = worms.find((v) => v.id === e.id);
        if (w) this.particles.push({ kind: "text", x: w.x, y: w.y - 22, vx: 0, vy: -26, life: 1.6, max: 1.6, size: 15, color: TEAM[w.team], text: `-${e.amount}` });
        break;
      }
      case "drown":
      case "splash": {
        const w = e.t === "drown" ? worms.find((v) => v.id === e.id) : undefined;
        const x = e.t === "splash" ? e.x : w?.x ?? 0;
        for (let i = 0; i < 14; i++) this.particles.push({ kind: "drop", x: x + (Math.random() - 0.5) * 16, y: this.waterY, vx: (Math.random() - 0.5) * 120, vy: -120 - Math.random() * 160, life: 0.9, max: 0.9, size: 2 + Math.random() * 2, color: "#9fd8ff" });
        break;
      }
      case "fizzle":
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          this.particles.push({ kind: "spark", x: e.x, y: e.y, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120, life: 0.6, max: 0.6, size: 2.2, color: "#d9c2ff" });
        }
        break;
      case "shot":
        this.particles.push({ kind: "line", x: e.x0, y: e.y0, x2: e.x1, y2: e.y1, vx: 0, vy: 0, life: 0.22, max: 0.22, size: 2, color: "#fff2c4" });
        break;
      case "fire":
        this.particles.push({ kind: "flash", x: e.x, y: e.y, vx: 0, vy: 0, life: 0.12, max: 0.12, size: 16, color: "#fff2c4" });
        break;
      case "die": {
        const w = worms.find((v) => v.id === e.id);
        if (w) for (let i = 0; i < 8; i++) this.particles.push({ kind: "smoke", x: w.x, y: w.y, vx: (Math.random() - 0.5) * 40, vy: -30, life: 1.2, max: 1.2, size: 10, color: "200,190,210" });
        break;
      }
    }
  }

  private waterY = 940;

  // ---------- frame ----------
  draw(dt: number, view: View | null, wells: { x: number; y: number }[], waterY: number): void {
    this.time += dt;
    this.waterY = waterY;
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSky();
    this.shake *= Math.exp(-dt * 7);
    const sx = (Math.random() - 0.5) * this.shake;
    const sy = (Math.random() - 0.5) * this.shake;

    this.drawHills();
    // world transform
    c.save();
    c.translate(this.vw / 2 + sx, this.vh / 2 + sy);
    c.scale(this.cam.zoom, this.cam.zoom);
    c.translate(-this.cam.x, -this.cam.y);
    this.drawClouds(dt);
    for (const w of wells) this.drawWell(w.x, w.y);
    this.drawWater(waterY, false);
    if (this.art) {
      const hw = this.vw / 2 / this.cam.zoom + 24;
      const hh = this.vh / 2 / this.cam.zoom + 24;
      const x0 = Math.max(0, Math.floor(this.cam.x - hw));
      const y0 = Math.max(0, Math.floor(this.cam.y - hh));
      const x1 = Math.min(this.art.t.w, Math.ceil(this.cam.x + hw));
      const y1 = Math.min(this.art.t.h, Math.ceil(this.cam.y + hh));
      if (x1 > x0 && y1 > y0) c.drawImage(this.art.canvas, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
    if (view) {
      for (const p of view.proj) this.drawProjectile(p, dt);
      for (const w of view.worms) this.drawWorm(w, view);
    }
    this.stepParticles(dt);
    this.drawWater(waterY, true);
    c.restore();
    if (view) this.drawLabels(view);
  }

  private drawSky(): void {
    const c = this.ctx;
    if (!this.sky) {
      // sky and low sun are painted once per resize; the frame only blits them
      const sky = document.createElement("canvas");
      sky.width = Math.max(1, Math.round(this.vw * this.dpr));
      sky.height = Math.max(1, Math.round(this.vh * this.dpr));
      const k = sky.getContext("2d")!;
      k.scale(this.dpr, this.dpr);
      const g = k.createLinearGradient(0, 0, 0, this.vh);
      g.addColorStop(0, "#1b1733");
      g.addColorStop(0.45, "#4a3566");
      g.addColorStop(0.78, "#b86b78");
      g.addColorStop(1, "#f2a675");
      k.fillStyle = g;
      k.fillRect(0, 0, this.vw, this.vh);
      const sun = this.vw * 0.72;
      const sunY = this.vh * 0.8;
      const sg = k.createRadialGradient(sun, sunY, 0, sun, sunY, this.vh * 0.5);
      sg.addColorStop(0, "rgba(255,226,170,0.85)");
      sg.addColorStop(0.12, "rgba(255,200,140,0.45)");
      sg.addColorStop(1, "rgba(255,180,120,0)");
      k.fillStyle = sg;
      k.fillRect(0, 0, this.vw, this.vh);
      this.sky = sky;
    }
    c.drawImage(this.sky, 0, 0, this.vw, this.vh);
    const top = Math.max(0, Math.min(1, (this.cam.y - 200) / 600));
    c.fillStyle = "#fff4e6";
    for (const s of this.stars) {
      c.globalAlpha = s.a * (0.4 + 0.6 * top) * (0.75 + 0.25 * Math.sin(this.time * 1.7 + s.x * 40));
      c.fillRect(s.x * this.vw, s.y * this.vh, 1.6, 1.6);
    }
    c.globalAlpha = 1;
  }

  private drawHills(): void {
    const c = this.ctx;
    const layers = [
      { k: 0.18, base: 0.72, amp: 42, f: 0.004, color: "#3d2d5c" },
      { k: 0.32, base: 0.8, amp: 34, f: 0.007, color: "#2e2249" },
    ];
    for (const L of layers) {
      c.fillStyle = L.color;
      c.beginPath();
      c.moveTo(0, this.vh);
      const ox = this.cam.x * L.k * this.cam.zoom;
      const oy = (this.cam.y - 520) * L.k * this.cam.zoom;
      for (let x = 0; x <= this.vw + 8; x += 8) {
        const wx = x + ox;
        const y = this.vh * L.base - oy + Math.sin(wx * L.f) * L.amp + Math.sin(wx * L.f * 2.7 + 1) * L.amp * 0.4;
        c.lineTo(x, y);
      }
      c.lineTo(this.vw, this.vh);
      c.fill();
    }
  }

  private drawClouds(dt: number): void {
    const c = this.ctx;
    c.fillStyle = "rgba(255,236,224,0.10)";
    for (const cl of this.clouds) {
      cl.x += this.wind * 26 * dt * cl.s;
      if (cl.x > WORLD_W + 400) cl.x = -400;
      if (cl.x < -400) cl.x = WORLD_W + 400;
      const s = 60 * cl.s;
      c.beginPath();
      for (const [dx, dy, rx, ry] of [[0, 0, 1.6, 0.42], [0.7, -0.2, 0.9, 0.38], [-0.8, 0.05, 0.8, 0.3]]) {
        c.moveTo(cl.x + (dx + rx) * s, cl.y + dy * s);
        c.ellipse(cl.x + dx * s, cl.y + dy * s, rx * s, ry * s, 0, 0, Math.PI * 2);
      }
      c.fill();
    }
  }

  private drawWell(x: number, y: number): void {
    const c = this.ctx;
    const t = this.time;
    if (!this.halo) {
      const h = document.createElement("canvas");
      h.width = h.height = 300;
      const k = h.getContext("2d")!;
      const g = k.createRadialGradient(150, 150, 0, 150, 150, 150);
      g.addColorStop(0, "rgba(183,140,255,0.35)");
      g.addColorStop(0.25, "rgba(183,140,255,0.12)");
      g.addColorStop(1, "rgba(183,140,255,0)");
      k.fillStyle = g;
      k.fillRect(0, 0, 300, 300);
      this.halo = h;
    }
    c.drawImage(this.halo, x - 150, y - 150);
    c.save();
    c.translate(x, y);
    c.strokeStyle = "rgba(217,194,255,0.55)";
    c.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const r = 26 + i * 18;
      c.save();
      c.rotate(t * (0.6 - i * 0.15) * (i % 2 ? -1 : 1));
      c.setLineDash([6 + i * 3, 9 + i * 4]);
      c.globalAlpha = 0.75 - i * 0.2;
      c.beginPath();
      c.ellipse(0, 0, r, r * 0.82, 0, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
    c.setLineDash([]);
    // in-falling motes
    c.fillStyle = "#e8dcff";
    for (let i = 0; i < 10; i++) {
      const ph = (t * 0.35 + i / 10) % 1;
      const r = 70 * (1 - ph) + 10;
      const a = i * 2.4 + ph * 5;
      c.globalAlpha = ph * 0.8;
      c.fillRect(Math.cos(a) * r - 1, Math.sin(a) * r - 1, 2, 2);
    }
    c.globalAlpha = 1;
    const core = c.createRadialGradient(0, 0, 0, 0, 0, 16);
    core.addColorStop(0, "#120a26");
    core.addColorStop(0.6, "#2a1650");
    core.addColorStop(0.85, "#b78cff");
    core.addColorStop(1, "rgba(183,140,255,0)");
    c.fillStyle = core;
    c.beginPath();
    c.arc(0, 0, 16, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  private drawWater(y: number, front: boolean): void {
    const c = this.ctx;
    const t = this.time;
    const x0 = this.cam.x - this.vw / 2 / this.cam.zoom - 20;
    const x1 = this.cam.x + this.vw / 2 / this.cam.zoom + 20;
    const bottom = Math.max(WORLD_H + 400, this.cam.y + this.vh / this.cam.zoom);
    const amp = front ? 4 : 3;
    const off = front ? 0 : 1.7;
    c.beginPath();
    c.moveTo(x0, bottom);
    for (let x = x0; x <= x1; x += 10) c.lineTo(x, y + (front ? 6 : -4) + Math.sin(x * 0.025 + t * (front ? 1.6 : 1.1) + off) * amp);
    c.lineTo(x1, bottom);
    c.closePath();
    if (front) {
      const g = c.createLinearGradient(0, y, 0, y + 120);
      g.addColorStop(0, "rgba(64,120,160,0.78)");
      g.addColorStop(1, "rgba(18,40,64,0.95)");
      c.fillStyle = g;
    } else c.fillStyle = "rgba(90,150,190,0.55)";
    c.fill();
    if (front) {
      c.strokeStyle = "rgba(190,230,255,0.55)";
      c.lineWidth = 1.5;
      c.beginPath();
      for (let x = x0; x <= x1; x += 10) {
        const yy = y + 6 + Math.sin(x * 0.025 + t * 1.6) * amp;
        if (x === x0) c.moveTo(x, yy);
        else c.lineTo(x, yy);
      }
      c.stroke();
    }
  }

  private drawWorm(w: WormView, v: View): void {
    const c = this.ctx;
    const active = v.actives[w.team] === w.id && v.snap.phase !== "over";
    const mine = w.team === v.seat;
    if (!w.alive) {
      if (w.y > this.waterY) return;
      c.fillStyle = "#c9c2d6";
      c.strokeStyle = "#7d7590";
      c.lineWidth = 1;
      c.beginPath();
      c.roundRect(w.x - 6, w.y - 9, 12, 17, [6, 6, 1, 1]);
      c.fill();
      c.stroke();
      c.fillStyle = "#7d7590";
      c.fillRect(w.x - 0.75, w.y - 6, 1.5, 8);
      c.fillRect(w.x - 3, w.y - 3.5, 6, 1.5);
      return;
    }
    const f = w.facing;
    const aim = active ? v.aims[w.team] : f === 1 ? -0.3 : Math.PI + 0.3;
    const breathe = Math.sin(this.time * 3 + w.id) * 0.6;
    // tail segments
    const skin = c.createLinearGradient(w.x, w.y - WORM_R, w.x, w.y + WORM_R);
    skin.addColorStop(0, "#ffc4b2");
    skin.addColorStop(1, "#e98473");
    const body = () => {
      c.beginPath();
      c.moveTo(w.x - f * 11 + 3.6, w.y + 5.2);
      c.arc(w.x - f * 11, w.y + 5.2, 3.6, 0, Math.PI * 2);
      c.moveTo(w.x - f * 6.5 + 5.6, w.y + 3.4);
      c.arc(w.x - f * 6.5, w.y + 3.4, 5.6, 0, Math.PI * 2);
      c.moveTo(w.x + WORM_R, w.y - breathe * 0.4);
      c.ellipse(w.x, w.y - breathe * 0.4, WORM_R, WORM_R + breathe * 0.4, 0, 0, Math.PI * 2);
    };
    body();
    c.strokeStyle = "rgba(58,22,30,0.75)";
    c.lineWidth = 2.2;
    c.stroke();
    c.fillStyle = skin;
    body();
    c.fill();
    // headband with a knot that trails behind
    const hy = w.y - breathe * 0.4;
    c.strokeStyle = TEAM[w.team];
    c.lineWidth = 3.4;
    c.beginPath();
    c.arc(w.x, hy, WORM_R - 1.4, Math.PI * 1.05, Math.PI * 1.95);
    c.stroke();
    c.fillStyle = TEAM[w.team];
    const kx = w.x - f * (WORM_R - 0.5);
    const flap = Math.sin(this.time * 6 + w.id) * 1.2;
    c.beginPath();
    c.moveTo(kx, hy - 4.5);
    c.lineTo(kx - f * 6, hy - 6.5 + flap);
    c.lineTo(kx - f * 5, hy - 2 + flap);
    c.closePath();
    c.fill();
    // weapon
    if (active) {
      c.save();
      c.translate(w.x, w.y + 1);
      c.rotate(aim);
      c.fillStyle = "#3b3550";
      c.beginPath();
      c.roundRect(2, -2.2, 14, 4.4, 2);
      c.fill();
      c.fillStyle = TEAM[w.team];
      c.fillRect(13, -2.2, 3, 4.4);
      c.restore();
    }
    // eyes
    const ex = Math.cos(aim);
    const ey = Math.sin(aim);
    for (const dx of [0.5, 4.2]) {
      const cx = w.x + f * dx;
      const cy = w.y - 3 - breathe * 0.4;
      c.fillStyle = "#fff";
      c.beginPath();
      c.arc(cx, cy, 2.5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#2a1a10";
      c.beginPath();
      c.arc(cx + ex * 1.1, cy + ey * 1.1, 1.2, 0, Math.PI * 2);
      c.fill();
    }
    if (active) {
      const R = 58;
      const cx = w.x + Math.cos(aim) * R;
      const cy = w.y + Math.sin(aim) * R;
      c.globalAlpha = mine ? 1 : 0.55;
      c.strokeStyle = "rgba(255,244,230,0.5)";
      c.lineWidth = 1.2 / this.cam.zoom;
      c.setLineDash([3, 5]);
      c.beginPath();
      c.moveTo(w.x + Math.cos(aim) * 16, w.y + Math.sin(aim) * 16);
      c.lineTo(cx, cy);
      c.stroke();
      c.setLineDash([]);
      c.strokeStyle = TEAM[w.team];
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cx, cy, 6, 0, Math.PI * 2);
      c.moveTo(cx - 10, cy);
      c.lineTo(cx - 3, cy);
      c.moveTo(cx + 3, cy);
      c.lineTo(cx + 10, cy);
      c.moveTo(cx, cy - 10);
      c.lineTo(cx, cy - 3);
      c.moveTo(cx, cy + 3);
      c.lineTo(cx, cy + 10);
      c.stroke();
      c.globalAlpha = 1;
      if (mine && v.power !== null) {
        const n = 12;
        for (let i = 0; i < n; i++) {
          const on = i / n < v.power;
          const r0 = 18 + i * 3.4;
          const px = w.x + Math.cos(aim) * r0;
          const py = w.y + Math.sin(aim) * r0;
          c.fillStyle = on ? `hsl(${48 - i * 4}, 100%, ${66 - i * 1.5}%)` : "rgba(255,244,230,0.18)";
          c.beginPath();
          c.arc(px, py, 1.4 + i * 0.22, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
  }

  private drawProjectile(p: ProjView, dt: number): void {
    const c = this.ctx;
    const a = Math.atan2(p.vy, p.vx);
    if (p.k === "rocket") {
      if (Math.random() < dt * 60) this.particles.push({ kind: "smoke", x: p.x - Math.cos(a) * 8, y: p.y - Math.sin(a) * 8, vx: (Math.random() - 0.5) * 10, vy: -8, life: 0.7, max: 0.7, size: 3 + Math.random() * 2, color: "230,220,235" });
      c.save();
      c.translate(p.x, p.y);
      c.rotate(a);
      c.fillStyle = "#ffcf6b";
      c.beginPath();
      c.moveTo(-6, -2);
      c.lineTo(-11 - Math.random() * 5, 0);
      c.lineTo(-6, 2);
      c.fill();
      c.fillStyle = "#ece6f4";
      c.beginPath();
      c.roundRect(-6, -2.6, 11, 5.2, 2.6);
      c.fill();
      c.fillStyle = "#ff7a59";
      c.beginPath();
      c.moveTo(5, -2.6);
      c.lineTo(9, 0);
      c.lineTo(5, 2.6);
      c.fill();
      c.fillStyle = "#6c6384";
      c.fillRect(-6, -4, 3, 8);
      c.restore();
      return;
    }
    const r = p.k === "bomblet" ? 2.6 : 4.6;
    c.fillStyle = p.k === "grenade" ? "#4f7d3c" : p.k === "cluster" ? "#c4473d" : "#3b3550";
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.45)";
    c.beginPath();
    c.arc(p.x - r * 0.35, p.y - r * 0.35, r * 0.35, 0, Math.PI * 2);
    c.fill();
    if (p.k !== "bomblet") {
      c.strokeStyle = "#d8d0e6";
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(p.x, p.y - r);
      c.lineTo(p.x + 2, p.y - r - 3);
      c.stroke();
    }
  }

  private stepParticles(dt: number): void {
    const c = this.ctx;
    const keep: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      keep.push(p);
      const k = p.life / p.max;
      if (p.kind === "dirt" || p.kind === "drop") p.vy += 520 * dt;
      if (p.kind === "smoke") {
        p.vx += this.wind * 30 * dt;
        p.size += 8 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      switch (p.kind) {
        case "flash":
          c.fillStyle = p.color;
          c.globalAlpha = k * 0.9;
          c.beginPath();
          c.arc(p.x, p.y, p.size * (1.15 - k * 0.4), 0, Math.PI * 2);
          c.fill();
          break;
        case "ring":
          c.strokeStyle = p.color;
          c.globalAlpha = k;
          c.lineWidth = 3 * k + 0.5;
          c.beginPath();
          c.arc(p.x, p.y, p.size * (1 - k * 0.7), 0, Math.PI * 2);
          c.stroke();
          break;
        case "smoke":
          c.fillStyle = `rgba(${p.color},${0.32 * k})`;
          c.beginPath();
          c.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          c.fill();
          break;
        case "line":
          c.strokeStyle = p.color;
          c.globalAlpha = k;
          c.lineWidth = p.size;
          c.beginPath();
          c.moveTo(p.x, p.y);
          c.lineTo(p.x2!, p.y2!);
          c.stroke();
          break;
        case "text":
          break;
        default:
          c.fillStyle = p.color;
          c.globalAlpha = Math.min(1, k * 1.5);
          c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      c.globalAlpha = 1;
    }
    this.particles = keep;
  }

  /** Screen-space labels: hp pills, damage numbers, the turn marker. Fixed pixel size for legibility at any zoom. */
  private drawLabels(v: View): void {
    const c = this.ctx;
    c.textAlign = "center";
    c.textBaseline = "middle";
    for (const w of v.worms) {
      if (!w.alive) continue;
      const s = this.toScreen(w.x, w.y - WORM_R);
      const y = s.y - 16;
      const label = String(w.hp);
      c.font = "800 11px ui-rounded, system-ui, sans-serif";
      const tw = c.measureText(label).width + 12;
      c.fillStyle = "rgba(23,18,42,0.78)";
      c.beginPath();
      c.roundRect(s.x - tw / 2, y - 8, tw, 16, 8);
      c.fill();
      c.fillStyle = TEAM[w.team];
      c.fillText(label, s.x, y + 0.5);
      if (v.actives[w.team] === w.id && v.snap.phase !== "over") {
        const bob = Math.sin(this.time * 5) * 3;
        c.fillStyle = TEAM[w.team];
        c.beginPath();
        c.moveTo(s.x - 6, y - 22 + bob);
        c.lineTo(s.x + 6, y - 22 + bob);
        c.lineTo(s.x, y - 14 + bob);
        c.fill();
      }
    }
    for (const p of this.particles) {
      if (p.kind !== "text") continue;
      const s = this.toScreen(p.x, p.y);
      c.globalAlpha = Math.min(1, (p.life / p.max) * 2);
      c.font = "800 16px ui-rounded, system-ui, sans-serif";
      c.lineWidth = 4;
      c.strokeStyle = "rgba(23,18,42,0.85)";
      c.strokeText(p.text!, s.x, s.y);
      c.fillStyle = p.color;
      c.fillText(p.text!, s.x, s.y);
      c.globalAlpha = 1;
    }
    // off-screen projectile indicator
    for (const p of v.proj) {
      const s = this.toScreen(p.x, p.y);
      if (s.y < 0 && s.x > 0 && s.x < this.vw) {
        c.fillStyle = "#ffcf6b";
        c.beginPath();
        c.moveTo(s.x, 64);
        c.lineTo(s.x - 6, 74);
        c.lineTo(s.x + 6, 74);
        c.fill();
      }
    }
  }

  get width(): number {
    return this.vw;
  }
  get height(): number {
    return this.vh;
  }
}
