import { describe, expect, test } from "bun:test";
import { leadText, standings } from "../../src/client/standings.ts";
import type { Snapshot, WormView } from "../../src/shared/protocol.ts";

const worm = (id: number, team: 0 | 1, hp: number, alive = hp > 0): WormView => ({ id, team, x: 0, y: 0, hp, alive, facing: 1 });

const snap = (worms: WormView[]): Snapshot =>
  ({ worms } as unknown as Snapshot);

const full = () => [worm(0, 0, 100), worm(1, 1, 100), worm(2, 0, 100), worm(3, 1, 100), worm(4, 0, 100), worm(5, 1, 100)];

describe("standings", () => {
  test("a fresh match is dead even", () => {
    const s = standings(snap(full()));
    expect(s.hp).toEqual([300, 300]);
    expect(s.alive).toEqual([3, 3]);
    expect(s.leader).toBeNull();
    expect(s.margin).toBe(0);
    expect(s.share).toBeCloseTo(0.5, 5);
  });

  test("the team with more health leads, by the difference", () => {
    const w = full();
    w[1].hp = 30;
    const s = standings(snap(w));
    expect(s.hp).toEqual([300, 230]);
    expect(s.leader).toBe(0);
    expect(s.margin).toBe(70);
    expect(s.share).toBeCloseTo(300 / 530, 5);
  });

  test("dead and drowned worms count zero even if their last hp lingers", () => {
    const w = full();
    w[0] = worm(0, 0, 40, false);
    const s = standings(snap(w));
    expect(s.hp[0]).toBe(200);
    expect(s.alive).toEqual([2, 3]);
    expect(s.leader).toBe(1);
  });

  test("equal health is broken by worms still standing", () => {
    const w = [worm(0, 0, 100), worm(1, 1, 50), worm(2, 0, 0), worm(3, 1, 50)];
    const s = standings(snap(w));
    expect(s.hp).toEqual([100, 100]);
    expect(s.alive).toEqual([1, 2]);
    expect(s.leader).toBe(1);
    expect(s.margin).toBe(0);
  });

  test("an empty board shares the bar evenly instead of dividing by zero", () => {
    const s = standings(snap([worm(0, 0, 0), worm(1, 1, 0)]));
    expect(s.share).toBe(0.5);
    expect(s.leader).toBeNull();
  });
});

describe("lead caption", () => {
  const names: [string, string] = ["Ada", "Bo"];
  const lead0 = standings(snap((() => { const w = full(); w[1].hp = 30; return w; })()));

  test("speaks to the player in the lead and to the one behind", () => {
    expect(leadText(lead0, names, 0)).toBe("You lead by 70");
    expect(leadText(lead0, names, 1)).toBe("Ada leads by 70");
  });

  test("an even board says so", () => {
    expect(leadText(standings(snap(full())), names, 0)).toBe("Dead even");
  });

  test("a lead on worms alone names the worm count", () => {
    const s = standings(snap([worm(0, 0, 100), worm(1, 1, 50), worm(2, 0, 0), worm(3, 1, 50)]));
    expect(leadText(s, names, 0)).toBe("Bo leads, 2 worms to 1");
  });
});
