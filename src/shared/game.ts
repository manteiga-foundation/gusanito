import {
  BOMBLET, COUNTDOWN_SECONDS, FALL_SAFE_SPEED, GRAVITY, JUMP_VX, JUMP_VY, MATCH_SECONDS, MAX_POWER, RISE_LAST_SECONDS,
  RISE_SPEED, STEP_UP, TICK, WALK_SPEED, WATER_Y, WEAPON_ORDER, WEAPONS, WELL_CORE, WELL_G, WELL_SOFT, WIND_ACCEL,
  WIND_SECONDS, WORLD_W, WORM_R, type WeaponId,
} from "./constants.ts";
import type { GameEvent, GameInput, Phase, ProjView, Seat, SeatView, Snapshot } from "./protocol.ts";
import { rng } from "./rng.ts";
import { Terrain } from "./terrain.ts";

export interface Worm {
  id: number;
  team: Seat;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  alive: boolean;
  facing: 1 | -1;
  grounded: boolean;
}

interface Projectile {
  id: number;
  k: ProjView["k"];
  team: Seat;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
  owner: number;
  age: number;
  resting: boolean;
}

export interface Well {
  x: number;
  y: number;
}

export interface GameOptions {
  seed: number;
  names: [string, string];
  wormsPerTeam?: number;
  terrain?: Terrain;
  /** x positions per team; worms are dropped onto the ground there */
  spawns?: [number[], number[]];
  wells?: Well[];
  /** fixed wind for the whole match (tests); shifts every WIND_SECONDS when omitted */
  wind?: number;
  /** opening countdown in seconds (default COUNTDOWN_SECONDS) */
  countdown?: number;
  /** match length in seconds (default MATCH_SECONDS) */
  matchSeconds?: number;
}

/** Per-player control state: both players drive a worm at the same time. */
interface Pilot {
  active: number;
  aim: number;
  weapon: WeaponId;
  move: -1 | 0 | 1;
  reload: number;
  reloadOf: number;
  ammo: Record<WeaponId, number>;
}

const BLAST_FOR: Record<ProjView["k"], { radius: number; damage: number; knock: number }> = {
  rocket: WEAPONS.rocket,
  grenade: WEAPONS.grenade,
  cluster: WEAPONS.cluster,
  bomblet: BOMBLET,
};

// perimeter sample offsets for the worm's body circle
const RING = Array.from({ length: 12 }, (_, i) => ({
  x: Math.cos((i / 12) * Math.PI * 2) * WORM_R,
  y: Math.sin((i / 12) * Math.PI * 2) * WORM_R,
}));

export class Game {
  readonly terrain: Terrain;
  readonly worms: Worm[] = [];
  readonly wells: Well[];
  readonly names: [string, string];
  projectiles: Projectile[] = [];
  phase: Phase;
  countdown: number;
  clock: number;
  wind = 0;
  windTimer = WIND_SECONDS;
  waterY = WATER_Y;
  winner: Seat | -1 | null = null;
  paused = false;
  readonly pilots: [Pilot, Pilot];

  private events: GameEvent[] = [];
  private rand: () => number;
  private fixedWind: number | undefined;
  private nextProjId = 1;
  private moveWells: boolean;
  private wellTargets: Well[] = [];

  constructor(opts: GameOptions) {
    this.rand = rng(opts.seed);
    this.names = opts.names;
    this.terrain = opts.terrain ?? Terrain.generate(opts.seed);
    this.fixedWind = opts.wind;
    const per = opts.wormsPerTeam ?? 3;
    const spawns = opts.spawns ?? this.pickSpawns(per);
    let id = 0;
    spawns.forEach((xs, team) => {
      for (const x of xs) this.worms.push(this.placeWorm(id++, team as Seat, x));
    });
    this.moveWells = opts.wells === undefined;
    this.wells = opts.wells ? opts.wells.map((w) => ({ ...w })) : this.pickWells();
    this.wellTargets = this.wells.map((w) => ({ ...w }));
    this.countdown = opts.countdown ?? COUNTDOWN_SECONDS;
    this.clock = opts.matchSeconds ?? MATCH_SECONDS;
    this.phase = this.countdown > 0 ? "countdown" : "play";
    const pilot = (team: Seat): Pilot => {
      const first = this.worms.find((w) => w.team === team)!;
      return {
        active: first.id,
        aim: first.facing === 1 ? -Math.PI / 4 : (-3 * Math.PI) / 4,
        weapon: "rocket",
        move: 0,
        reload: 0,
        reloadOf: 1,
        ammo: { rocket: -1, grenade: -1, cluster: WEAPONS.cluster.ammo, shotgun: -1 },
      };
    };
    this.pilots = [pilot(0), pilot(1)];
    this.wind = this.fixedWind ?? this.rollWind(0);
  }

  // ---------- setup ----------

  private surfaceY(x: number): number {
    return this.terrain.groundBelow(x, 0);
  }

  private pickSpawns(per: number): [number[], number[]] {
    const chosen: { x: number; y: number }[] = [];
    const teams: [number[], number[]] = [[], []];
    for (let i = 0; i < per * 2; i++) {
      for (let attempt = 0; attempt < 4000; attempt++) {
        const x = Math.floor(120 + this.rand() * (WORLD_W - 240));
        const y = this.surfaceY(x);
        if (y > WATER_Y - 40 || y < 60) continue;
        if (Math.abs(this.surfaceY(x - 8) - this.surfaceY(x + 8)) > 6) continue;
        const cy = y - WORM_R - 1;
        if (chosen.some((c) => Math.hypot(c.x - x, c.y - cy) < 90)) continue;
        if (this.collides(x, cy)) continue;
        chosen.push({ x, y: cy });
        teams[(i % 2) as Seat].push(x);
        break;
      }
    }
    return teams;
  }

  private placeWorm(id: number, team: Seat, x: number): Worm {
    let y = this.surfaceY(x) - WORM_R - 1;
    while (this.collides(x, y) && y > 0) y--;
    return { id, team, x, y, vx: 0, vy: 0, hp: 100, alive: true, facing: team === 0 ? 1 : -1, grounded: true };
  }

  private pickWells(): Well[] {
    const wells: Well[] = [];
    for (let i = 0; i < 2; i++) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const x = WORLD_W * (0.22 + 0.56 * this.rand());
        if (wells.some((w) => Math.abs(w.x - x) < 350)) continue;
        const top = this.surfaceY(x);
        const y = 110 + this.rand() * Math.max(10, top - 330);
        if (this.terrain.solid(x, y) || this.terrain.groundBelow(x, y - 60) < y + 120) continue;
        wells.push({ x, y });
        break;
      }
    }
    return wells;
  }

  private rollWind(prev: number): number {
    let w: number;
    do w = Math.round((this.rand() * 2 - 1) * 100) / 100;
    while (Math.abs(w - prev) < 0.05);
    return w;
  }

  // ---------- queries ----------

  activeWorm(seat: Seat): Worm {
    return this.worms.find((w) => w.id === this.pilots[seat].active)!;
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  snapshot(): Snapshot {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const seat = (p: Pilot): SeatView => ({
      active: p.active,
      aim: Math.round(p.aim * 1000) / 1000,
      weapon: p.weapon,
      reload: Math.round(p.reload * 100) / 100,
      reloadOf: p.reloadOf,
      ammo: { ...p.ammo },
    });
    return {
      phase: this.phase,
      countdown: Math.ceil(this.countdown),
      clock: Math.ceil(this.clock),
      wind: this.wind,
      wells: this.wells.map((w) => ({ x: r1(w.x), y: r1(w.y) })),
      worms: this.worms.map((w) => ({ id: w.id, team: w.team, x: r1(w.x), y: r1(w.y), hp: Math.max(0, Math.round(w.hp)), alive: w.alive, facing: w.facing })),
      proj: this.projectiles.map((p) => ({ id: p.id, team: p.team, k: p.k, x: r1(p.x), y: r1(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), fuse: Math.ceil(p.fuse) })),
      seats: [seat(this.pilots[0]), seat(this.pilots[1])],
      waterY: Math.round(this.waterY * 10) / 10,
      winner: this.winner,
    };
  }

  // ---------- input ----------

  handle(seat: Seat, msg: GameInput): void {
    if (this.phase === "over") return;
    // during the countdown players may aim, pick a weapon and hold a direction; acting waits for "go"
    if (this.phase === "countdown" && (msg.t === "fire" || msg.t === "jump")) return;
    const p = this.pilots[seat];
    const me = this.activeWorm(seat);
    if (!me || !me.alive) return;
    switch (msg.t) {
      case "move":
        p.move = msg.dir;
        break;
      case "jump":
        if (me.grounded) {
          me.vy = JUMP_VY;
          me.vx = JUMP_VX * me.facing;
          me.grounded = false;
        }
        break;
      case "aim":
        if (Number.isFinite(msg.angle)) {
          p.aim = Math.atan2(Math.sin(msg.angle), Math.cos(msg.angle));
          me.facing = Math.cos(p.aim) >= 0 ? 1 : -1;
        }
        break;
      case "weapon":
        if (WEAPONS[msg.id] && p.ammo[msg.id] !== 0) p.weapon = msg.id;
        break;
      case "fire":
        if (p.reload <= 0) this.fire(seat, me, Math.min(1, Math.max(0, Number(msg.power) || 0)));
        break;
    }
  }

  // ---------- simulation ----------

  run(seconds: number): void {
    const n = Math.round(seconds / TICK);
    for (let i = 0; i < n; i++) this.step();
  }

  step(): void {
    if (this.paused || this.phase === "over") return;
    const dt = TICK;

    if (this.phase === "countdown") {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = "play";
      }
    } else {
      this.clock = Math.max(0, this.clock - dt);
      if (this.clock < RISE_LAST_SECONDS) this.waterY = Math.max(320, this.waterY - RISE_SPEED * dt);
      this.windTimer -= dt;
      if (this.windTimer <= 0) {
        this.windTimer = WIND_SECONDS;
        if (this.fixedWind === undefined) this.wind = this.rollWind(this.wind);
        if (this.moveWells) this.retargetWells();
      }
      if (this.moveWells) this.driftWells(dt);
      for (const s of [0, 1] as Seat[]) {
        const p = this.pilots[s];
        p.reload = Math.max(0, p.reload - dt);
        const me = this.activeWorm(s);
        if (p.move !== 0 && me.alive && me.grounded) this.walk(s, me, p.move, dt);
      }
    }

    for (const w of this.worms) if (w.alive) this.stepWorm(w, dt);
    for (const p of [...this.projectiles]) this.stepProjectile(p, dt);
    this.reap();
    this.checkEnd();
  }

  private collides(x: number, y: number): boolean {
    if (this.terrain.solid(x, y)) return true;
    for (const o of RING) if (this.terrain.solid(x + o.x, y + o.y)) return true;
    return false;
  }

  private supported(w: Worm): boolean {
    for (let dx = -3; dx <= 3; dx += 3) if (this.terrain.solid(w.x + dx, w.y + WORM_R + 1.5)) return true;
    return false;
  }

  private walk(seat: Seat, w: Worm, dir: -1 | 1, dt: number): void {
    const p = this.pilots[seat];
    if (w.facing !== dir) {
      w.facing = dir;
      p.aim = Math.atan2(Math.sin(Math.PI - p.aim), Math.cos(Math.PI - p.aim));
    }
    const nx = w.x + dir * WALK_SPEED * dt;
    for (let lift = 0; lift <= STEP_UP; lift++) {
      if (!this.collides(nx, w.y - lift)) {
        w.x = nx;
        w.y -= lift;
        for (let drop = 0; drop < STEP_UP; drop++) {
          if (this.collides(w.x, w.y + 1)) break;
          w.y += 1;
        }
        if (!this.supported(w)) w.grounded = false;
        return;
      }
    }
  }

  private stepWorm(w: Worm, dt: number): void {
    if (w.grounded) {
      if (!this.supported(w)) w.grounded = false;
      else return;
    }
    w.vy += GRAVITY * dt;
    const n = Math.max(1, Math.ceil((Math.max(Math.abs(w.vx), Math.abs(w.vy)) * dt) / 1.5));
    for (let i = 0; i < n; i++) {
      const nx = w.x + (w.vx * dt) / n;
      if (this.collides(nx, w.y)) w.vx *= -0.35;
      else w.x = nx;
      const ny = w.y + (w.vy * dt) / n;
      if (this.collides(w.x, ny)) {
        if (w.vy > 0) {
          const impact = w.vy;
          if (impact > FALL_SAFE_SPEED) this.hurt(w, Math.round((impact - FALL_SAFE_SPEED) / 8));
          if (impact > 160) {
            w.vy = -impact * 0.25;
            w.vx *= 0.6;
          } else {
            w.vy = 0;
            w.vx = 0;
            while (!this.collides(w.x, w.y + 1) && w.y < this.terrain.h) w.y += 1;
            w.grounded = true;
            return;
          }
        } else w.vy = 0;
        break;
      }
      w.y = ny;
    }
    if (w.y > this.waterY) {
      w.alive = false;
      w.hp = 0;
      this.events.push({ t: "drown", id: w.id });
    }
  }

  private fire(seat: Seat, me: Worm, power: number): void {
    const p = this.pilots[seat];
    const spec = WEAPONS[p.weapon];
    const dx = Math.cos(p.aim);
    const dy = Math.sin(p.aim);
    if (p.ammo[p.weapon] > 0) p.ammo[p.weapon]--;
    p.reload = spec.reload;
    p.reloadOf = spec.reload;
    this.events.push({ t: "fire", seat, weapon: p.weapon, x: me.x, y: me.y });

    if (p.weapon === "shotgun") this.hitscan(me, dx, dy);
    else {
      const sx = me.x + dx * (WORM_R + 4);
      const sy = me.y + dy * (WORM_R + 4);
      const speed = Math.max(0.05, power) * MAX_POWER;
      const proj: Projectile = {
        id: this.nextProjId++, k: p.weapon as Projectile["k"], team: seat, x: sx, y: sy, vx: dx * speed, vy: dy * speed,
        fuse: spec.fuse, owner: me.id, age: 0, resting: false,
      };
      if (this.terrain.solid(sx, sy)) this.explode(proj);
      else this.projectiles.push(proj);
    }
    if (p.ammo[p.weapon] === 0) p.weapon = WEAPON_ORDER.find((w) => p.ammo[w] !== 0)!;
    p.move = 0;
    this.switchWorm(seat);
  }

  /** Hand the player's control to their next living worm (wrapping); stays put when it is the last one. */
  private switchWorm(seat: Seat): void {
    const p = this.pilots[seat];
    const roster = this.worms.filter((w) => w.team === seat);
    const at = roster.findIndex((w) => w.id === p.active);
    for (let i = 1; i <= roster.length; i++) {
      const w = roster[(at + i) % roster.length];
      if (w.alive) {
        if (w.id !== p.active) {
          p.active = w.id;
          w.facing = Math.cos(p.aim) >= 0 ? 1 : -1;
          this.events.push({ t: "switch", seat, active: w.id });
        }
        return;
      }
    }
  }

  private hitscan(me: Worm, dx: number, dy: number): void {
    let x = me.x + dx * (WORM_R + 2);
    let y = me.y + dy * (WORM_R + 2);
    const x0 = x;
    const y0 = y;
    for (let d = 0; d < 900; d += 2) {
      const hit = this.worms.find((w) => w.alive && w.id !== me.id && Math.hypot(w.x - x, w.y - y) < WORM_R + 1);
      if (hit) {
        this.hurt(hit, WEAPONS.shotgun.damage);
        hit.vx += dx * WEAPONS.shotgun.knock;
        hit.vy += dy * WEAPONS.shotgun.knock - 60;
        hit.grounded = false;
        this.events.push({ t: "shot", seat: me.team, x0, y0, x1: x, y1: y }, { t: "boom", x, y, r: 6, team: me.team });
        return;
      }
      if (this.terrain.solid(x, y)) {
        this.terrain.carve(x, y, WEAPONS.shotgun.radius);
        this.events.push({ t: "shot", seat: me.team, x0, y0, x1: x, y1: y }, { t: "boom", x, y, r: WEAPONS.shotgun.radius, team: me.team });
        return;
      }
      x += dx * 2;
      y += dy * 2;
    }
    this.events.push({ t: "shot", seat: me.team, x0, y0, x1: x, y1: y });
  }

  private stepProjectile(p: Projectile, dt: number): void {
    p.age += dt;
    if (p.fuse > 0) {
      p.fuse -= dt;
      if (p.fuse <= 0) {
        this.explode(p);
        return;
      }
    }
    if (p.resting) {
      if (this.terrain.solid(p.x, p.y + 3)) return;
      p.resting = false;
    }
    const bounces = p.k === "grenade" || p.k === "cluster";
    const windy = p.k === "rocket";
    const n = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dt) / 2));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      let ax = windy ? this.wind * WIND_ACCEL : 0;
      let ay = GRAVITY;
      for (const w of this.wells) {
        const ddx = w.x - p.x;
        const ddy = w.y - p.y;
        const d = Math.hypot(ddx, ddy);
        if (d < WELL_CORE) {
          this.remove(p);
          this.events.push({ t: "fizzle", x: p.x, y: p.y });
          return;
        }
        const a = WELL_G / (d * d + WELL_SOFT * WELL_SOFT);
        ax += (ddx / d) * a;
        ay += (ddy / d) * a;
      }
      p.vx += ax * h;
      p.vy += ay * h;
      const nx = p.x + p.vx * h;
      const ny = p.y + p.vy * h;
      if (ny > this.waterY) {
        this.remove(p);
        this.events.push({ t: "splash", x: nx });
        return;
      }
      if (nx < -300 || nx > this.terrain.w + 300) {
        this.remove(p);
        return;
      }
      if (this.terrain.solid(nx, ny)) {
        if (!bounces) {
          p.x = nx;
          p.y = ny;
          this.explode(p);
          return;
        }
        const nrm = this.terrain.normal(nx, ny);
        const dot = p.vx * nrm.x + p.vy * nrm.y;
        if (dot < 0) {
          p.vx = (p.vx - 2 * dot * nrm.x) * 0.5;
          p.vy = (p.vy - 2 * dot * nrm.y) * 0.5;
        }
        if (Math.hypot(p.vx, p.vy) < 25) {
          p.vx = 0;
          p.vy = 0;
          p.resting = true;
        }
        return;
      }
      p.x = nx;
      p.y = ny;
      if (!bounces) {
        const hit = this.worms.find((w) => w.alive && Math.hypot(w.x - p.x, w.y - p.y) < WORM_R + 2 && !(w.id === p.owner && p.age < 0.2));
        if (hit) {
          this.explode(p);
          return;
        }
      }
    }
  }

  private remove(p: Projectile): void {
    this.projectiles = this.projectiles.filter((q) => q !== p);
  }

  private explode(p: Projectile): void {
    this.remove(p);
    const spec = BLAST_FOR[p.k];
    this.blast(p.x, p.y, spec.radius, spec.damage, spec.knock, p.team);
    if (p.k === "cluster") {
      for (let i = 0; i < BOMBLET.count; i++) {
        const spread = (i / (BOMBLET.count - 1) - 0.5) * 2;
        this.projectiles.push({
          id: this.nextProjId++, k: "bomblet", team: p.team, x: p.x, y: p.y - 6,
          vx: spread * 130 + (this.rand() - 0.5) * 30, vy: -170 - this.rand() * 90,
          fuse: 0, owner: -1, age: 0, resting: false,
        });
      }
    }
  }

  private blast(x: number, y: number, r: number, damage: number, knock: number, team: Seat): void {
    this.terrain.carve(x, y, r);
    this.events.push({ t: "boom", x: Math.round(x), y: Math.round(y), r, team });
    for (const w of this.worms) {
      if (!w.alive) continue;
      const dx = w.x - x;
      const dy = w.y - y;
      const d = Math.hypot(dx, dy);
      const f = 1 - d / (r + WORM_R);
      if (f <= 0) continue;
      this.hurt(w, Math.round(damage * f));
      const ux = d > 0.5 ? dx / d : 0;
      const uy = d > 0.5 ? dy / d : -1;
      w.vx += ux * knock * f;
      w.vy += uy * knock * f - 80 * f;
      w.grounded = false;
    }
  }

  private hurt(w: Worm, amount: number): void {
    if (amount <= 0 || !w.alive) return;
    w.hp -= amount;
    this.events.push({ t: "hurt", id: w.id, amount });
  }

  /** Worms out of health die at once; a player whose worm fell takes over the next one. */
  private reap(): void {
    for (const w of this.worms) {
      if (w.alive && w.hp <= 0) {
        w.alive = false;
        w.hp = 0;
        this.events.push({ t: "die", id: w.id });
      }
    }
    for (const s of [0, 1] as Seat[]) if (!this.activeWorm(s).alive) this.switchWorm(s);
  }

  private checkEnd(): void {
    if (this.phase === "over") return;
    const alive = [0, 1].map((t) => this.worms.some((w) => w.alive && w.team === t));
    if (!alive[0] || !alive[1]) return this.finish(alive[0] ? 0 : alive[1] ? 1 : -1);
    if (this.phase === "play" && this.clock <= 0) {
      const hp = [0, 1].map((t) => this.worms.reduce((a, w) => a + (w.alive && w.team === t ? w.hp : 0), 0));
      const n = [0, 1].map((t) => this.worms.filter((w) => w.alive && w.team === t).length);
      if (hp[0] !== hp[1]) return this.finish(hp[0] > hp[1] ? 0 : 1);
      if (n[0] !== n[1]) return this.finish(n[0] > n[1] ? 0 : 1);
      return this.finish(-1);
    }
  }

  private finish(winner: Seat | -1): void {
    this.phase = "over";
    this.winner = winner;
    for (const p of this.pilots) p.move = 0;
  }

  private retargetWells(): void {
    this.wellTargets = this.wells.map((w) => {
      const nx = Math.min(WORLD_W * 0.85, Math.max(WORLD_W * 0.15, w.x + (this.rand() - 0.5) * 160));
      const ny = Math.min(this.waterY - 200, Math.max(90, w.y + (this.rand() - 0.5) * 80));
      return !this.terrain.solid(nx, ny) && this.terrain.groundBelow(nx, ny - 40) > ny + 60 ? { x: nx, y: ny } : { ...w };
    });
  }

  /** Wells glide toward their targets so shots never meet a sudden jump. */
  private driftWells(dt: number): void {
    const k = 1 - Math.exp(-dt * 0.4);
    this.wells.forEach((w, i) => {
      const t = this.wellTargets[i];
      if (!t) return;
      w.x += (t.x - w.x) * k;
      w.y += (t.y - w.y) * k;
    });
  }

  forfeit(seat: Seat): void {
    if (this.phase === "over") return;
    this.finish((1 - seat) as Seat);
    this.projectiles = [];
  }
}
