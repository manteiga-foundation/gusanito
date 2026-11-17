import { describe, expect, test } from "bun:test";
import { Game, type GameOptions } from "../../src/shared/game.ts";
import { Terrain } from "../../src/shared/terrain.ts";
import { COUNTDOWN_SECONDS, MATCH_SECONDS, RISE_LAST_SECONDS, TICK, WATER_Y, WEAPONS, WIND_SECONDS, WORM_R } from "../../src/shared/constants.ts";

const flatGame = (extra: Partial<GameOptions> = {}) =>
  new Game({
    seed: 1,
    names: ["Ada", "Bo"],
    terrain: Terrain.flat(500),
    spawns: [[300], [700]],
    wells: [],
    wind: 0,
    countdown: 0,
    ...extra,
  });

const booms = (evs: { t: string }[]) => evs.filter((e) => e.t === "boom") as { t: "boom"; x: number; y: number; r: number }[];
const team = (g: Game, t: 0 | 1) => g.worms.filter((w) => w.team === t);

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

  test("a match opens with a countdown in which nobody can act, then both players play", () => {
    const g = flatGame({ countdown: undefined });
    const s = g.snapshot();
    expect(s.phase).toBe("countdown");
    expect(s.countdown).toBe(COUNTDOWN_SECONDS);
    expect(s.clock).toBe(MATCH_SECONDS);
    g.handle(0, { t: "move", dir: 1 });
    g.run(1);
    expect(g.activeWorm(0).x).toBe(300);
    g.run(COUNTDOWN_SECONDS);
    expect(g.snapshot().phase).toBe("play");
    expect(g.activeWorm(0).x).toBeGreaterThan(300);
  });

  test("each player starts in control of one of their own worms", () => {
    const s = flatGame().snapshot();
    const byId = new Map(s.worms.map((w) => [w.id, w]));
    expect(byId.get(s.seats[0].active)!.team).toBe(0);
    expect(byId.get(s.seats[1].active)!.team).toBe(1);
  });
});

describe("both players at once", () => {
  test("both players walk their own worms in the same moment", () => {
    const g = flatGame();
    g.handle(0, { t: "move", dir: 1 });
    g.handle(1, { t: "move", dir: -1 });
    g.run(1);
    expect(g.activeWorm(0).x).toBeGreaterThan(330);
    expect(g.activeWorm(1).x).toBeLessThan(670);
    expect(g.activeWorm(0).facing).toBe(1);
    expect(g.activeWorm(1).facing).toBe(-1);
  });

  test("a jump leaves the ground and lands again", () => {
    const g = flatGame();
    const w = g.activeWorm(0);
    const y0 = w.y;
    g.handle(0, { t: "jump" });
    g.run(0.2);
    expect(w.y).toBeLessThan(y0 - 10);
    g.run(2);
    expect(Math.abs(w.y - y0)).toBeLessThan(1);
  });

  test("each player aims independently", () => {
    const g = flatGame();
    g.handle(0, { t: "aim", angle: -0.5 });
    g.handle(1, { t: "aim", angle: -2.5 });
    const s = g.snapshot();
    expect(s.seats[0].aim).toBeCloseTo(-0.5, 2);
    expect(s.seats[1].aim).toBeCloseTo(-2.5, 2);
  });

  test("both players can have shots in the air together", () => {
    const g = flatGame({ spawns: [[300], [1700]] });
    g.handle(0, { t: "aim", angle: -Math.PI / 4 });
    g.handle(1, { t: "aim", angle: (-3 * Math.PI) / 4 });
    g.handle(0, { t: "fire", power: 0.7 });
    g.handle(1, { t: "fire", power: 0.7 });
    g.run(0.3);
    const s = g.snapshot();
    expect(s.proj.length).toBe(2);
    expect(new Set(s.proj.map((p) => p.team))).toEqual(new Set([0, 1]));
  });

  test("firing hands control straight to the shooter's next worm; the other player is unaffected", () => {
    const g = flatGame({ spawns: [[200, 400, 600], [1200, 1400, 1600]] });
    const before1 = g.activeWorm(1).id;
    const first = g.activeWorm(0).id;
    g.handle(0, { t: "aim", angle: -Math.PI / 3 });
    g.handle(0, { t: "fire", power: 0.5 });
    const next = g.activeWorm(0);
    expect(next.id).not.toBe(first);
    expect(next.team).toBe(0);
    expect(g.activeWorm(1).id).toBe(before1);
    // the new worm moves at once, without waiting for the shot to land
    g.handle(0, { t: "move", dir: 1 });
    const x0 = next.x;
    g.run(0.5);
    expect(next.x).toBeGreaterThan(x0 + 15);
  });

  test("control cycles through the living worms of the team", () => {
    const g = flatGame({ spawns: [[200, 400], [1200, 1400]] });
    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      order.push(g.activeWorm(0).x);
      g.handle(0, { t: "aim", angle: -Math.PI / 4 });
      g.handle(0, { t: "fire", power: 0.5 });
      g.run(WEAPONS.rocket.reload + 0.1);
    }
    expect(order.map(Math.round)).toEqual([200, 400, 200]);
  });

  test("a weapon reloads before the same player can fire again", () => {
    const g = flatGame({ spawns: [[300, 500], [1500, 1700]] });
    g.handle(0, { t: "aim", angle: -Math.PI / 4 });
    g.handle(0, { t: "fire", power: 0.5 });
    expect(g.snapshot().seats[0].reload).toBeGreaterThan(0);
    g.handle(0, { t: "fire", power: 0.5 });
    g.run(0.1);
    expect(g.snapshot().proj.length).toBe(1);
    g.run(WEAPONS.rocket.reload);
    expect(g.snapshot().seats[0].reload).toBe(0);
    g.handle(0, { t: "fire", power: 0.5 });
    expect(g.snapshot().proj.length).toBeGreaterThanOrEqual(1);
    expect(g.drainEvents().filter((e) => e.t === "fire").length).toBe(2);
  });
});

describe("weapons", () => {
  test("fire, shot and blast events say whose they are", () => {
    const g = flatGame({ spawns: [[300, 500], [1500, 1700]] });
    g.handle(1, { t: "aim", angle: Math.PI / 2 });
    g.handle(1, { t: "fire", power: 0.5 });
    g.handle(0, { t: "weapon", id: "shotgun" });
    g.handle(0, { t: "aim", angle: Math.PI / 2 });
    g.handle(0, { t: "fire", power: 1 });
    g.run(0.2);
    const ev = g.drainEvents() as any[];
    expect(ev.filter((e) => e.t === "fire").map((e) => e.seat).sort()).toEqual([0, 1]);
    expect(ev.find((e) => e.t === "shot").seat).toBe(0);
    expect(ev.filter((e) => e.t === "boom").map((e) => e.team).sort()).toEqual([0, 1]);
  });

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
    expect(team(g, 0)[0].hp).toBeLessThan(100);
    expect(team(g, 1)[0].hp).toBe(100);
  });

  test("worms die quickly: a direct rocket takes about half a worm, three shotgun hits finish one", () => {
    const g = flatGame({ spawns: [[300], [380]] });
    g.handle(0, { t: "aim", angle: 0 });
    g.handle(0, { t: "fire", power: 1 });
    g.run(0.3);
    const lost = 100 - team(g, 1)[0].hp;
    expect(lost).toBeGreaterThanOrEqual(45);
    expect(lost).toBeLessThan(100);
    expect(Math.ceil(100 / WEAPONS.shotgun.damage)).toBeLessThanOrEqual(3);
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
    expect(team(g, 1)[0].hp).toBeLessThan(70);
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

  test("a cluster bomb splits into bomblets, and its ammo is limited per player", () => {
    const g = flatGame({ spawns: [[300], [1500]] });
    expect(g.snapshot().seats[0].ammo.cluster).toBe(2);
    g.handle(0, { t: "weapon", id: "cluster" });
    g.handle(0, { t: "aim", angle: -Math.PI / 4 });
    g.handle(0, { t: "fire", power: 0.4 });
    expect(g.snapshot().seats[0].ammo.cluster).toBe(1);
    expect(g.snapshot().seats[1].ammo.cluster).toBe(2);
    g.run(8);
    expect(booms(g.drainEvents()).length).toBeGreaterThanOrEqual(5);
  });

  test("the shotgun is an instant hitscan with a short reload", () => {
    const g = flatGame({ spawns: [[300], [450]] });
    g.handle(0, { t: "weapon", id: "shotgun" });
    g.handle(0, { t: "aim", angle: 0 });
    g.handle(0, { t: "fire", power: 1 });
    expect(team(g, 1)[0].hp).toBe(100 - WEAPONS.shotgun.damage);
    expect(WEAPONS.shotgun.reload).toBeLessThan(WEAPONS.rocket.reload);
  });

  test("a weapon can be changed at any time, an empty one cannot be chosen", () => {
    const g = flatGame({ spawns: [[300, 500], [1500, 1700]] });
    g.handle(0, { t: "weapon", id: "cluster" });
    for (let i = 0; i < 2; i++) {
      g.handle(0, { t: "aim", angle: -Math.PI / 2 });
      g.handle(0, { t: "fire", power: 0.05 });
      g.run(WEAPONS.cluster.reload + 0.1);
      g.handle(0, { t: "weapon", id: "cluster" });
    }
    expect(g.snapshot().seats[0].ammo.cluster).toBe(0);
    expect(g.snapshot().seats[0].weapon).not.toBe("cluster");
  });
});

describe("endings", () => {
  test("a worm whose health runs out dies at once and control moves on", () => {
    const g = flatGame({ spawns: [[300, 900], [1500, 1700]] });
    const first = g.activeWorm(0);
    first.hp = 10;
    g.handle(0, { t: "aim", angle: Math.PI / 2 });
    g.handle(0, { t: "fire", power: 0.3 });
    g.run(0.5);
    expect(first.alive).toBe(false);
    expect(g.drainEvents().some((e) => e.t === "die")).toBe(true);
    expect(g.activeWorm(0).alive).toBe(true);
  });

  test("a worm that falls into the water drowns, and the last team standing wins", () => {
    const g = flatGame({ spawns: [[300], [700]] });
    g.terrain.clearRect(680, 0, 720, 1000);
    g.run(3);
    const s = g.snapshot();
    expect(team(g, 1)[0].alive).toBe(false);
    expect(s.phase).toBe("over");
    expect(s.winner).toBe(0);
  });

  test("when both teams fall together it is a draw", () => {
    const g = flatGame({ spawns: [[300], [700]] });
    g.terrain.clearRect(0, 0, 2000, 1000);
    g.run(3);
    expect(g.snapshot().winner).toBe(-1);
  });

  test("when the clock runs out the healthier team wins", () => {
    const g = flatGame({ matchSeconds: 5 });
    team(g, 1)[0].hp = 60;
    g.run(5.2);
    const s = g.snapshot();
    expect(s.phase).toBe("over");
    expect(s.winner).toBe(0);
  });

  test("a level board at the final whistle is a draw", () => {
    const g = flatGame({ matchSeconds: 5 });
    g.run(5.2);
    expect(g.snapshot().winner).toBe(-1);
  });

  test("the water rises in the final minute", () => {
    const g = flatGame({ matchSeconds: RISE_LAST_SECONDS + 10 });
    g.run(9);
    expect(g.snapshot().waterY).toBe(WATER_Y);
    g.run(20);
    expect(g.snapshot().waterY).toBeLessThan(WATER_Y - 10);
  });

  test("the wind shifts on a fixed rhythm", () => {
    const g = flatGame({ wind: undefined, seed: 11 });
    const w0 = g.snapshot().wind;
    g.run(WIND_SECONDS - 1);
    expect(g.snapshot().wind).toBe(w0);
    g.run(2);
    expect(g.snapshot().wind).not.toBe(w0);
  });

  test("a paused match freezes its clock", () => {
    const g = flatGame();
    g.run(2);
    const t = g.snapshot().clock;
    g.paused = true;
    g.run(10);
    expect(g.snapshot().clock).toBe(t);
  });

  test("the simulation ticks at a fixed step", () => {
    expect(TICK).toBeCloseTo(1 / 60, 6);
  });
});
