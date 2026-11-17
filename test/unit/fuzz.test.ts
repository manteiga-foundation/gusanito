import { expect, test } from "bun:test";
import { Game } from "../../src/shared/game.ts";
import { WEAPON_ORDER } from "../../src/shared/constants.ts";
import { rng } from "../../src/shared/rng.ts";

test("long random matches never throw, keep numbers finite, and always progress", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const g = new Game({ seed, names: ["A", "B"] });
    const r = rng(seed * 31);
    let lastTurn = 0;
    let stuck = 0;
    for (let tick = 0; tick < 60 * 60 * 12 && g.phase !== "over"; tick++) {
      if (tick % 20 === 0) {
        const seat = g.team;
        const roll = r();
        if (roll < 0.15) g.handle(seat, { t: "move", dir: r() < 0.5 ? -1 : 1 });
        else if (roll < 0.2) g.handle(seat, { t: "move", dir: 0 });
        else if (roll < 0.23) g.handle(seat, { t: "jump" });
        else if (roll < 0.3) g.handle(seat, { t: "aim", angle: -Math.PI * r() });
        else if (roll < 0.32) g.handle(seat, { t: "weapon", id: WEAPON_ORDER[Math.floor(r() * 4)] });
        else if (roll < 0.36) g.handle(seat, { t: "fire", power: r() });
      }
      g.step();
      g.drainEvents();
      if (g.turn === lastTurn) stuck++;
      else {
        lastTurn = g.turn;
        stuck = 0;
      }
      expect(stuck).toBeLessThan(60 * 90);
    }
    for (const w of g.worms) {
      expect(Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.hp)).toBe(true);
    }
    expect(g.turn).toBeGreaterThan(5);
  }
}, 60000);
