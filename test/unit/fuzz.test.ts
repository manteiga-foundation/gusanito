import { expect, test } from "bun:test";
import { Game } from "../../src/shared/game.ts";
import { WEAPON_ORDER } from "../../src/shared/constants.ts";
import { rng } from "../../src/shared/rng.ts";

test("long random simultaneous matches never throw, keep numbers finite, and always end", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const g = new Game({ seed, names: ["A", "B"] });
    const r = rng(seed * 31);
    let fired = 0;
    for (let tick = 0; tick < 60 * 200 && g.phase !== "over"; tick++) {
      if (tick % 15 === 0) {
        for (const seat of [0, 1] as const) {
          const roll = r();
          if (roll < 0.15) g.handle(seat, { t: "move", dir: r() < 0.5 ? -1 : 1 });
          else if (roll < 0.2) g.handle(seat, { t: "move", dir: 0 });
          else if (roll < 0.23) g.handle(seat, { t: "jump" });
          else if (roll < 0.33) g.handle(seat, { t: "aim", angle: -Math.PI * r() });
          else if (roll < 0.36) g.handle(seat, { t: "weapon", id: WEAPON_ORDER[Math.floor(r() * 4)] });
          else if (roll < 0.45) g.handle(seat, { t: "fire", power: r() });
        }
      }
      g.step();
      fired += g.drainEvents().filter((e) => e.t === "fire").length;
    }
    for (const w of g.worms) expect(Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.hp)).toBe(true);
    expect(g.phase).toBe("over");
    expect(fired).toBeGreaterThan(10);
  }
}, 60000);

test("the same seed and the same inputs always give the same match", () => {
  const play = (seed: number) => {
    const g = new Game({ seed, names: ["A", "B", "C"] });
    const r = rng(seed * 17);
    const trace: string[] = [];
    for (let tick = 0; tick < 60 * 40 && g.phase !== "over"; tick++) {
      if (tick % 12 === 0) {
        for (const seat of [0, 1, 2]) {
          const roll = r();
          if (roll < 0.2) g.handle(seat, { t: "move", dir: r() < 0.5 ? -1 : 1 });
          else if (roll < 0.3) g.handle(seat, { t: "aim", angle: -Math.PI * r() });
          else if (roll < 0.35) g.handle(seat, { t: "weapon", id: WEAPON_ORDER[Math.floor(r() * 4)] });
          else if (roll < 0.5) g.handle(seat, { t: "fire", power: r() });
        }
      }
      g.step();
      if (tick % 60 === 0) trace.push(JSON.stringify(g.snapshot()));
    }
    return trace;
  };
  for (const seed of [3, 11]) expect(play(seed)).toEqual(play(seed));
  expect(play(3)).not.toEqual(play(11));
}, 60000);
