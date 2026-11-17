import { describe, expect, test } from "bun:test";
import { Game, type GameOptions } from "../../src/shared/game.ts";
import { Terrain } from "../../src/shared/terrain.ts";
import { WORM_R, WATER_Y, TURN_SECONDS, TICK } from "../../src/shared/constants.ts";

const flatGame = (extra: Partial<GameOptions> = {}) =>
  new Game({
    seed: 1,
    names: ["Ada", "Bo"],
    terrain: Terrain.flat(500),
    spawns: [[300], [700]],
    wells: [],
    wind: 0,
    ...extra,
  });

const booms = (evs: { t: string }[]) => evs.filter((e) => e.t === "boom") as { t: "boom"; x: number; y: number; r: number }[];

describe("game setup", () => {
  test("generated matches place every worm on ground, above water, apart", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = new Game({ seed, names: ["A", "B"] });
      expect(g.worms.length).toBe(6);
      for (const w of g.worms) {
        expect(g.terrain.solid(w.x, w.y)).toBe(false);
        expect(g.terrain.groundBelow(w.x, w.y) - (w.y + WORM_R)).toBeLessThan(3);
        expect(w.y).toBeLessThan(WATER_Y - 20);
      }
      for (const a of g.worms)
        for (const b of g.worms) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(60);
    }
  });

  test("each match has two gravity wells in the sky by default", () => {
    const g = new Game({ seed: 5, names: ["A", "B"] });
    expect(g.wells.length).toBe(2);
    for (const w of g.wells) expect(g.terrain.solid(w.x, w.y)).toBe(false);
  });

  test("the first turn belongs to player one with a full timer", () => {
    const g = flatGame();
    const s = g.snapshot();
    expect(s.phase).toBe("aim");
    expect(s.team).toBe(0);
    expect(s.timer).toBe(TURN_SECONDS);
    expect(s.worms.find((w) => w.id === s.active)!.team).toBe(0);
  });
});

describe("movement", () => {
  test("walking moves the active worm along flat ground", () => {
    const g = flatGame();
    const w = g.activeWorm();
    const y0 = w.y;
    g.handle(0, { t: "move", dir: 1 });
    g.run(1);
    g.handle(0, { t: "move", dir: 0 });
    expect(w.x - 300).toBeGreaterThan(30);
    expect(w.x - 300).toBeLessThan(90);
    expect(Math.abs(w.y - y0)).toBeLessThan(1);
    expect(w.facing).toBe(1);
  });

  test("input from the player whose turn it is not is ignored", () => {
    const g = flatGame();
    const other = g.worms.find((w) => w.team === 1)!;
    g.handle(1, { t: "move", dir: -1 });
    g.run(1);
    expect(other.x).toBe(700);
    expect(g.activeWorm().x).toBe(300);
  });

  test("a jump leaves the ground and lands again", () => {
    const g = flatGame();
    const w = g.activeWorm();
    const y0 = w.y;
    g.handle(0, { t: "jump" });
    g.run(0.2);
    expect(w.y).toBeLessThan(y0 - 10);
    g.run(2);
    expect(Math.abs(w.y - y0)).toBeLessThan(1);
  });
});

describe("weapons", () => {
  test("a rocket fired into the ground carves a crater and hurts worms inside the blast only", () => {
    const g = flatGame();
    g.handle(0, { t: "weapon", id: "rocket" });
    g.handle(0, { t: "aim", angle: Math.PI / 2 });
    g.handle(0, { t: "fire", power: 0.5 });
    g.run(0.5);
    const b = booms(g.drainEvents());
    expect(b.length).toBe(1);
    expect(Math.abs(b[0].x - 300)).toBeLessThan(15);
    expect(g.terrain.solid(300, 505)).toBe(false);
    const me = g.worms.find((w) => w.team === 0)!;
    const them = g.worms.find((w) => w.team === 1)!;
    expect(me.hp).toBeLessThan(100);
    expect(them.hp).toBe(100);
  });

  test("a rocket explodes on contact with an enemy worm", () => {
    const g = flatGame({ spawns: [[300], [380]] });
    g.handle(0, { t: "aim", angle: 0 });
    g.handle(0, { t: "fire", power: 1 });
    g.run(0.3);
    const b = booms(g.drainEvents());
    expect(b.length).toBe(1);
    expect(b[0].x).toBeGreaterThan(355);
    expect(b[0].x).toBeLessThan(385);
    expect(g.worms.find((w) => w.team === 1)!.hp).toBeLessThan(70);
  });

  test("wind pushes rockets downwind", () => {
    const land = (wind: number) => {
      const g = flatGame({ wind, spawns: [[300], [1700]] });
      g.handle(0, { t: "aim", angle: -Math.PI / 4 });
      g.handle(0, { t: "fire", power: 0.7 });
      g.run(5);
      return booms(g.drainEvents())[0].x;
    };
    expect(land(1) - land(0)).toBeGreaterThan(40);
    expect(land(-1) - land(0)).toBeLessThan(-40);
  });

  test("a gravity well bends a projectile's path", () => {
    const land = (wells: GameOptions["wells"]) => {
      const g = flatGame({ wells, spawns: [[300], [1700]] });
      g.handle(0, { t: "aim", angle: -Math.PI / 4 });
      g.handle(0, { t: "fire", power: 0.7 });
      g.run(5);
      return booms(g.drainEvents())[0].x;
    };
    expect(Math.abs(land([{ x: 700, y: 250 }]) - land([]))).toBeGreaterThan(30);
  });

  test("a grenade bounces and only explodes when its fuse runs out", () => {
    const g = flatGame({ spawns: [[300], [1500]] });
    g.handle(0, { t: "weapon", id: "grenade" });
    g.handle(0, { t: "aim", angle: -Math.PI / 4 });
    g.handle(0, { t: "fire", power: 0.4 });
    g.run(2.5);
    expect(booms(g.drainEvents()).length).toBe(0);
    g.run(1);
    expect(booms(g.drainEvents()).length).toBe(1);
  });

  test("a cluster bomb splits into bomblets, and its ammo is limited", () => {
    const g = flatGame({ spawns: [[300], [1500]] });
    expect(g.snapshot().ammo.cluster).toBe(2);
    g.handle(0, { t: "weapon", id: "cluster" });
    g.handle(0, { t: "aim", angle: -Math.PI / 4 });
    g.handle(0, { t: "fire", power: 0.4 });
    expect(g.snapshot().ammo.cluster).toBe(1);
    g.run(8);
    expect(booms(g.drainEvents()).length).toBeGreaterThanOrEqual(5);
  });

  test("the shotgun fires twice before the turn moves to retreat", () => {
    const g = flatGame({ spawns: [[300], [450]] });
    g.handle(0, { t: "weapon", id: "shotgun" });
    g.handle(0, { t: "aim", angle: 0 });
    g.handle(0, { t: "fire", power: 1 });
    g.run(0.2);
    expect(g.snapshot().phase).toBe("aim");
    expect(g.snapshot().shots).toBe(1);
    g.handle(0, { t: "fire", power: 1 });
    g.run(0.2);
    expect(g.snapshot().phase).toBe("retreat");
    expect(g.worms.find((w) => w.team === 1)!.hp).toBeLessThan(70);
  });
});

describe("turns", () => {
  test("after a shot and the retreat, the turn passes to player two with new wind", () => {
    const g = flatGame({ wind: undefined, seed: 11 });
    const wind0 = g.snapshot().wind;
    g.handle(0, { t: "aim", angle: Math.PI / 2 });
    g.handle(0, { t: "fire", power: 0.5 });
    g.run(0.1);
    expect(g.snapshot().phase).toBe("retreat");
    g.run(8);
    const s = g.snapshot();
    expect(s.phase).toBe("aim");
    expect(s.team).toBe(1);
    expect(s.wind).not.toBe(wind0);
    g.handle(0, { t: "move", dir: 1 });
    const theirs = g.activeWorm();
    expect(theirs.team).toBe(1);
  });

  test("an idle turn ends when the timer runs out", () => {
    const g = flatGame();
    g.run(TURN_SECONDS + 2);
    expect(g.snapshot().team).toBe(1);
  });

  test("skip passes the turn", () => {
    const g = flatGame();
    g.handle(0, { t: "skip" });
    g.run(1);
    expect(g.snapshot().team).toBe(1);
  });

  test("teams rotate through their worms", () => {
    const g = new Game({ seed: 1, names: ["A", "B"], terrain: Terrain.flat(500), spawns: [[200, 400], [1200, 1400]], wells: [], wind: 0 });
    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      order.push(g.activeWorm().x);
      g.handle(g.snapshot().team as 0 | 1, { t: "skip" });
      g.run(1);
    }
    expect(order).toEqual([200, 1200, 400, 1400]);
  });

  test("a worm that falls into the water drowns, and the last team standing wins", () => {
    const g = flatGame({ spawns: [[300], [700]] });
    g.terrain.clearRect(680, 0, 720, 1000);
    g.run(3);
    const them = g.worms.find((w) => w.team === 1)!;
    expect(them.alive).toBe(false);
    g.handle(0, { t: "skip" });
    g.run(2);
    const s = g.snapshot();
    expect(s.phase).toBe("over");
    expect(s.winner).toBe(0);
  });

  test("a paused match freezes its timer", () => {
    const g = flatGame();
    g.run(2);
    const t = g.snapshot().timer;
    g.paused = true;
    g.run(10);
    expect(g.snapshot().timer).toBe(t);
  });

  test("the simulation ticks at a fixed step", () => {
    expect(TICK).toBeCloseTo(1 / 60, 6);
  });
});
