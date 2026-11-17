import type { WeaponId } from "../shared/constants.ts";
import type { GameEvent, ProjView, Seat, WormView } from "../shared/protocol.ts";

/** Time for Fire held to reach full power. */
export const CHARGE_MS = 1300;
/** How long the camera stays on the blast of your own shot before returning to your worm. */
export const LINGER_MS = 1200;
const MIN_POWER = 0.08;
const HOLD_AFTER_FIRE_MS = 450;
const SHOT_HOLD_MS = 900;

/** Power for a Fire press held this long: linear, from a small floor to full at CHARGE_MS. */
export function chargePower(heldMs: number): number {
  return Math.min(1, Math.max(MIN_POWER, heldMs / CHARGE_MS));
}

/** Hitscan weapons fire on release with no charge. */
export function charges(weapon: WeaponId): boolean {
  return weapon !== "shotgun";
}

/** Name and health for the label over a worm. */
export function wormLabel(w: WormView, names: string[]): { name: string; frac: number; text: string } {
  return { name: names[w.team], frac: Math.max(0, Math.min(1, w.hp / 100)), text: String(Math.max(0, w.hp)) };
}

interface Scene {
  worms: WormView[];
  proj: ProjView[];
  actives: number[];
}

/**
 * Decides where one player's camera looks: their shot while it flies, the blast for a moment
 * after it lands, then their next worm. The opponent's action never takes the camera.
 */
export class Director {
  private hold: { x: number; y: number; until: number } | null = null;
  private trackedAt = -Infinity;

  constructor(private seat: Seat | null) {}

  setSeat(seat: Seat | null): void {
    this.seat = seat;
    this.hold = null;
  }

  onEvent(e: GameEvent, now: number): void {
    if (this.seat === null) return;
    if (e.t === "fire" && e.seat === this.seat) this.hold = { x: e.x, y: e.y, until: now + HOLD_AFTER_FIRE_MS };
    else if (e.t === "shot" && e.seat === this.seat) this.hold = { x: e.x1, y: e.y1, until: now + SHOT_HOLD_MS };
    else if (e.t === "boom" && e.team === this.seat && now - this.trackedAt < 400) this.hold = { x: e.x, y: e.y, until: now + LINGER_MS };
  }

  target(s: Scene, now: number): { x: number; y: number; rate: number } | null {
    const flying = s.proj.filter((p) => p.team === this.seat && (p.vx !== 0 || p.vy !== 0));
    if (flying.length) {
      const p = flying[flying.length - 1];
      this.trackedAt = now;
      return { x: p.x, y: p.y, rate: 5 };
    }
    if (this.hold && now < this.hold.until) return { x: this.hold.x, y: this.hold.y, rate: 4 };
    this.hold = null;
    if (this.seat === null) return null;
    const w = s.worms.find((x) => x.id === s.actives[this.seat!]);
    return w ? { x: w.x, y: w.y, rate: 3.5 } : null;
  }
}
