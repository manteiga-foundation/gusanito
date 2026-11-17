import type { Seat, Snapshot } from "../shared/protocol.ts";

export interface Standings {
  /** remaining health per team (dead worms count zero) */
  hp: number[];
  /** worms still standing per team */
  alive: number[];
  /** worms per team at the start */
  size: number[];
  /** null when the top of the board is even */
  leader: Seat | null;
  /** health gap between the leader and the runner-up */
  margin: number;
  /** each team's share of all remaining health, summing to 1 (equal shares when nothing is left) */
  share: number[];
  /** teams from first to last */
  order: number[];
}

export function standings(s: Pick<Snapshot, "worms">, teamCount?: number): Standings {
  const n = teamCount ?? s.worms.reduce((m, w) => Math.max(m, w.team + 1), 0);
  const hp = Array(n).fill(0);
  const alive = Array(n).fill(0);
  const size = Array(n).fill(0);
  for (const w of s.worms) {
    size[w.team]++;
    if (!w.alive) continue;
    alive[w.team]++;
    hp[w.team] += Math.max(0, w.hp);
  }
  const order = [...Array(n).keys()].sort((a, b) => hp[b] - hp[a] || alive[b] - alive[a] || a - b);
  const [first, second] = order;
  let leader: Seat | null = null;
  let margin = 0;
  if (second !== undefined && (hp[first] !== hp[second] || alive[first] !== alive[second])) {
    leader = first;
    margin = hp[first] - hp[second];
  }
  const total = hp.reduce((a, b) => a + b, 0);
  const share = hp.map((h) => (total > 0 ? h / total : 1 / Math.max(1, n)));
  return { hp, alive, size, leader, margin, share, order };
}

/** One short line, worded for the player reading it. */
export function leadText(st: Standings, names: string[], seat: Seat | null): string {
  if (st.leader === null) return "Dead even";
  const who = st.leader === seat ? "You lead" : `${names[st.leader]} leads`;
  if (st.margin > 0) return `${who} by ${st.margin}`;
  const runnerUp = st.order[1];
  return `${who}, ${st.alive[st.leader]} worms to ${st.alive[runnerUp]}`;
}
