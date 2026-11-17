import type { Seat, Snapshot } from "../shared/protocol.ts";

export interface Standings {
  /** remaining health per team (dead worms count zero) */
  hp: [number, number];
  /** worms still standing per team */
  alive: [number, number];
  /** worms per team at the start */
  size: [number, number];
  /** null when the board is even */
  leader: Seat | null;
  /** health difference between the teams */
  margin: number;
  /** team one's share of all remaining health, 0..1 (0.5 when nothing is left) */
  share: number;
}

export function standings(s: Pick<Snapshot, "worms">): Standings {
  const hp: [number, number] = [0, 0];
  const alive: [number, number] = [0, 0];
  const size: [number, number] = [0, 0];
  for (const w of s.worms) {
    size[w.team]++;
    if (!w.alive) continue;
    alive[w.team]++;
    hp[w.team] += Math.max(0, w.hp);
  }
  const margin = Math.abs(hp[0] - hp[1]);
  let leader: Seat | null = null;
  if (hp[0] !== hp[1]) leader = hp[0] > hp[1] ? 0 : 1;
  else if (alive[0] !== alive[1]) leader = alive[0] > alive[1] ? 0 : 1;
  const total = hp[0] + hp[1];
  return { hp, alive, size, leader, margin, share: total > 0 ? hp[0] / total : 0.5 };
}

/** One short line, worded for the player reading it. */
export function leadText(st: Standings, names: [string, string], seat: Seat | null): string {
  if (st.leader === null) return "Dead even";
  const who = st.leader === seat ? "You lead" : `${names[st.leader]} leads`;
  if (st.margin > 0) return `${who} by ${st.margin}`;
  const other = (1 - st.leader) as Seat;
  return `${who}, ${st.alive[st.leader]} worms to ${st.alive[other]}`;
}
