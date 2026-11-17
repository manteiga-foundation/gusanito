import { describe, expect, test } from "bun:test";
import { CHARGE_MS, Director, LINGER_MS, chargePower, charges, wormLabel } from "../../src/client/director.ts";
import type { ProjView, WormView } from "../../src/shared/protocol.ts";

const worm = (id: number, team: 0 | 1, x: number, y = 400, hp = 100): WormView => ({ id, team, x, y, hp, alive: hp > 0, facing: 1 });
const rocket = (team: 0 | 1, x: number, y: number, vx = 300, vy = -100): ProjView => ({ id: 7, team, k: "rocket", x, y, vx, vy, fuse: 0 });
const scene = (proj: ProjView[] = []) => ({
  worms: [worm(0, 0, 100), worm(1, 0, 600), worm(2, 1, 1500)],
  proj,
  actives: [1, 2] as [number, number],
});

describe("camera director", () => {
  test("right after my shot it holds on the shooter instead of jumping to my next worm", () => {
    const d = new Director(0);
    d.onEvent({ t: "fire", seat: 0, weapon: "rocket", x: 100, y: 400 }, 1000);
    const t = d.target(scene(), 1100)!;
    expect(t.x).toBe(100);
  });

  test("while my shot flies the camera follows it", () => {
    const d = new Director(0);
    d.onEvent({ t: "fire", seat: 0, weapon: "rocket", x: 100, y: 400 }, 1000);
    const t = d.target(scene([rocket(0, 420, 250)]), 1300)!;
    expect(t.x).toBe(420);
    expect(t.y).toBe(250);
  });

  test("when my shot explodes the camera lingers on the blast, then returns to my worm", () => {
    const d = new Director(0);
    d.onEvent({ t: "fire", seat: 0, weapon: "rocket", x: 100, y: 400 }, 1000);
    d.target(scene([rocket(0, 800, 380)]), 1500);
    d.onEvent({ t: "boom", team: 0, x: 820, y: 390, r: 42 }, 1510);
    expect(d.target(scene(), 1520 + LINGER_MS - 100)!.x).toBe(820);
    expect(d.target(scene(), 1520 + LINGER_MS + 50)!.x).toBe(600);
  });

  test("the opponent's shots and blasts never take my camera", () => {
    const d = new Director(0);
    d.onEvent({ t: "fire", seat: 1, weapon: "rocket", x: 1500, y: 400 }, 1000);
    expect(d.target(scene([rocket(1, 1200, 200)]), 1100)!.x).toBe(600);
    d.onEvent({ t: "boom", team: 1, x: 1100, y: 400, r: 42 }, 1200);
    expect(d.target(scene(), 1300)!.x).toBe(600);
  });

  test("a grenade at rest releases the camera, and its later blast does not yank it back", () => {
    const d = new Director(0);
    d.onEvent({ t: "fire", seat: 0, weapon: "grenade", x: 100, y: 400 }, 1000);
    const resting: ProjView = { id: 9, team: 0, k: "grenade", x: 300, y: 395, vx: 0, vy: 0, fuse: 2 };
    expect(d.target(scene([resting]), 2000)!.x).toBe(600);
    d.onEvent({ t: "boom", team: 0, x: 300, y: 395, r: 44 }, 3500);
    expect(d.target(scene(), 3600)!.x).toBe(600);
  });

  test("my shotgun blast holds on where the pellet landed", () => {
    const d = new Director(0);
    d.onEvent({ t: "shot", seat: 0, x0: 100, y0: 400, x1: 520, y1: 390 }, 1000);
    expect(d.target(scene(), 1300)!.x).toBe(520);
  });
});

describe("hold-to-charge fire", () => {
  test("power builds with the time Fire is held and caps at full", () => {
    expect(chargePower(0)).toBeGreaterThan(0);
    expect(chargePower(0)).toBeLessThan(0.15);
    expect(chargePower(CHARGE_MS / 2)).toBeCloseTo(0.5, 1);
    expect(chargePower(CHARGE_MS)).toBe(1);
    expect(chargePower(CHARGE_MS * 3)).toBe(1);
  });

  test("the shotgun does not charge; every other weapon does", () => {
    expect(charges("shotgun")).toBe(false);
    for (const w of ["rocket", "grenade", "cluster"] as const) expect(charges(w)).toBe(true);
  });
});

describe("worm label", () => {
  test("names the player and gives the health as a bar fraction and a number", () => {
    const l = wormLabel(worm(3, 1, 0, 0, 64), ["Ada", "Bo"]);
    expect(l).toEqual({ name: "Bo", frac: 0.64, text: "64" });
  });

  test("the bar never overflows or goes negative", () => {
    expect(wormLabel(worm(3, 0, 0, 0, 140), ["Ada", "Bo"]).frac).toBe(1);
    expect(wormLabel({ ...worm(3, 0, 0, 0, 0), hp: -5 }, ["Ada", "Bo"]).frac).toBe(0);
  });
});
