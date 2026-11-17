import {
  BOMBLET, FALL_SAFE_SPEED, GRAVITY, JUMP_VX, JUMP_VY, MAX_POWER, RETREAT_SECONDS, SETTLE_MIN_SECONDS,
  STEP_UP, SUDDEN_DEATH_RISE, SUDDEN_DEATH_TURN, TICK, TURN_SECONDS, WALK_SPEED, WATER_Y, WEAPONS,
  WELL_CORE, WELL_G, WELL_SOFT, WIND_ACCEL, WORLD_W, WORM_R, type WeaponId,
} from "./constants.ts";
import type { GameEvent, GameInput, Phase, ProjView, Seat, Snapshot } from "./protocol.ts";
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
  /** fixed wind for every turn (tests); random per turn when omitted */
  wind?: number;
}

const BLAST_FOR: Record<Exclude<ProjView["k"], never>, { radius: number; damage: number; knock: number }> = {
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
  phase: Phase = "aim";
  turn = 1;
  team: Seat = 0;
  activeId = 0;
  timer = TURN_SECONDS;
  retreat = 0;
  settleTime = 0;
  wind = 0;
  weapon: WeaponId = "rocket";
  aim = -Math.PI / 4;
  shots = 0;
  ammo: [Record<WeaponId, number>, Record<WeaponId, number>];
  waterY = WATER_Y;
  winner: Seat | -1 | null = null;
  paused = false;

  private moveDir: -1 | 0 | 1 = 0;
  private events: GameEvent[] = [];
  private rand: () => number;
  private fixedWind: number | undefined;
  private lastIdx: [number, number] = [-1, -1];
  private nextProjId = 1;
  private moveWells: boolean;

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
    const fresh = (): Record<WeaponId, number> => ({ rocket: -1, grenade: -1, cluster: WEAPONS.cluster.ammo, shotgun: -1 });
    this.ammo = [fresh(), fresh()];
    this.beginTurn(0);
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

  // ---------- queries ----------

  activeWorm(): Worm {
    return this.worms.find((w) => w.id === this.activeId)!;
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  snapshot(): Snapshot {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    return {
      phase: this.phase,
      turn: this.turn,
      team: this.team,
      active: this.activeId,
      timer: Math.ceil(this.timer),
      retreat: Math.ceil(this.retreat),
      wind: this.wind,
      wells: this.wells.map((w) => ({ x: r1(w.x), y: r1(w.y) })),
      worms: this.worms.map((w) => ({ id: w.id, team: w.team, x: r1(w.x), y: r1(w.y), hp: Math.max(0, Math.round(w.hp)), alive: w.alive, facing: w.facing })),
      proj: this.projectiles.map((p) => ({ id: p.id, k: p.k, x: r1(p.x), y: r1(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), fuse: Math.ceil(p.fuse) })),
      weapon: this.weapon,
      aim: Math.round(this.aim * 1000) / 1000,
      shots: this.shots,
      ammo: { ...this.ammo[this.team] },
      waterY: this.waterY,
      winner: this.winner,
    };
  }

  // ---------- input ----------

  handle(seat: Seat, msg: GameInput): void {
    if (this.phase === "over" || seat !== this.team) return;
    const me = this.activeWorm();
    const canAct = (this.phase === "aim" || this.phase === "retreat") && me.alive;
    switch (msg.t) {
      case "move":
        this.moveDir = canAct ? msg.dir : 0;
        break;
      case "jump":
        if (canAct && me.grounded) {
          me.vy = JUMP_VY;
          me.vx = JUMP_VX * me.facing;
          me.grounded = false;
        }
        break;
      case "aim":
        if (Number.isFinite(msg.angle)) {
          this.aim = Math.atan2(Math.sin(msg.angle), Math.cos(msg.angle));
          me.facing = Math.cos(this.aim) >= 0 ? 1 : -1;
        }
        break;
      case "weapon":
        if (this.phase === "aim" && this.shots === 0 && WEAPONS[msg.id] && this.ammo[this.team][msg.id] !== 0) this.weapon = msg.id;
        break;
      case "fire":
        if (this.phase === "aim" && me.alive) this.fire(me, Math.min(1, Math.max(0, Number(msg.power) || 0)));
        break;
      case "skip":
        if (this.phase === "aim") this.toSettle();
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
    const me = this.activeWorm();

    if (this.phase === "aim") {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 0;
        this.toSettle();
      }
    } else if (this.phase === "retreat") {
      this.retreat -= dt;
      if (this.retreat <= 0) {
        this.retreat = 0;
        this.toSettle();
      }
    } else if (this.phase === "settle") {
      this.settleTime += dt;
    }

    if (this.moveDir !== 0 && (this.phase === "aim" || this.phase === "retreat") && me.alive && me.grounded) this.walk(me, this.moveDir, dt);

    for (const w of this.worms) if (w.alive) this.stepWorm(w, dt);
    for (const p of [...this.projectiles]) this.stepProjectile(p, dt);

    if ((this.phase === "aim" || this.phase === "retreat") && !me.alive) this.toSettle();
    if (this.phase === "settle" && this.settleTime >= SETTLE_MIN_SECONDS && this.isCalm()) this.endTurn();
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

  private walk(w: Worm, dir: -1 | 1, dt: number): void {
    if (w.facing !== dir) {
      w.facing = dir;
      this.aim = Math.atan2(Math.sin(Math.PI - this.aim), Math.cos(Math.PI - this.aim));
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

  private fire(me: Worm, power: number): void {
    const spec = WEAPONS[this.weapon];
    const dx = Math.cos(this.aim);
    const dy = Math.sin(this.aim);
    this.moveDir = 0;
    if (this.ammo[this.team][this.weapon] > 0) this.ammo[this.team][this.weapon]--;
    this.events.push({ t: "fire", weapon: this.weapon, x: me.x, y: me.y });

    if (this.weapon === "shotgun") {
      this.hitscan(me, dx, dy);
      this.shots++;
      if (this.shots >= spec.shots) this.toRetreat();
      return;
    }
    this.shots++;
    const sx = me.x + dx * (WORM_R + 4);
    const sy = me.y + dy * (WORM_R + 4);
    const speed = Math.max(0.05, power) * MAX_POWER;
    const p: Projectile = {
      id: this.nextProjId++, k: this.weapon as Projectile["k"], x: sx, y: sy, vx: dx * speed, vy: dy * speed,
      fuse: spec.fuse, owner: me.id, age: 0, resting: false,
    };
    if (this.terrain.solid(sx, sy)) this.explode(p);
    else this.projectiles.push(p);
    this.toRetreat();
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
        this.events.push({ t: "shot", x0, y0, x1: x, y1: y }, { t: "boom", x, y, r: 6 });
        return;
      }
      if (this.terrain.solid(x, y)) {
        this.terrain.carve(x, y, WEAPONS.shotgun.radius);
        this.events.push({ t: "shot", x0, y0, x1: x, y1: y }, { t: "boom", x, y, r: WEAPONS.shotgun.radius });
        return;
      }
      x += dx * 2;
      y += dy * 2;
    }
    this.events.push({ t: "shot", x0, y0, x1: x, y1: y });
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
    this.blast(p.x, p.y, spec.radius, spec.damage, spec.knock);
    if (p.k === "cluster") {
      for (let i = 0; i < BOMBLET.count; i++) {
        const spread = (i / (BOMBLET.count - 1) - 0.5) * 2;
        this.projectiles.push({
          id: this.nextProjId++, k: "bomblet", x: p.x, y: p.y - 6,
          vx: spread * 130 + (this.rand() - 0.5) * 30, vy: -170 - this.rand() * 90,
          fuse: 0, owner: -1, age: 0, resting: false,
        });
      }
    }
  }

  private blast(x: number, y: number, r: number, damage: number, knock: number): void {
    this.terrain.carve(x, y, r);
    this.events.push({ t: "boom", x: Math.round(x), y: Math.round(y), r });
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

  // ---------- turn flow ----------

  private toRetreat(): void {
    this.phase = "retreat";
    this.retreat = RETREAT_SECONDS;
  }

  private toSettle(): void {
    this.phase = "settle";
    this.settleTime = 0;
    this.moveDir = 0;
  }

  private isCalm(): boolean {
    return this.projectiles.length === 0 && this.worms.every((w) => !w.alive || w.grounded);
  }

  private endTurn(): void {
    for (const w of this.worms) {
      if (w.alive && w.hp <= 0) {
        w.alive = false;
        w.hp = 0;
        this.events.push({ t: "die", id: w.id });
      }
    }
    const alive = [0, 1].map((t) => this.worms.some((w) => w.alive && w.team === t));
    if (!alive[0] || !alive[1]) {
      this.phase = "over";
      this.winner = alive[0] ? 0 : alive[1] ? 1 : -1;
      return;
    }
    this.turn++;
    if (this.turn > SUDDEN_DEATH_TURN) this.waterY = Math.max(300, this.waterY - SUDDEN_DEATH_RISE);
    if (this.moveWells) this.driftWells();
    this.beginTurn((1 - this.team) as Seat);
  }

  private driftWells(): void {
    for (const w of this.wells) {
      const nx = Math.min(WORLD_W * 0.85, Math.max(WORLD_W * 0.15, w.x + (this.rand() - 0.5) * 120));
      const ny = Math.min(this.waterY - 200, Math.max(90, w.y + (this.rand() - 0.5) * 60));
      if (!this.terrain.solid(nx, ny) && this.terrain.groundBelow(nx, ny - 40) > ny + 60) {
        w.x = nx;
        w.y = ny;
      }
    }
  }

  private beginTurn(team: Seat): void {
    const roster = this.worms.filter((w) => w.team === team);
    let idx = this.lastIdx[team];
    for (let i = 0; i < roster.length; i++) {
      idx = (idx + 1) % roster.length;
      if (roster[idx].alive) break;
    }
    this.lastIdx[team] = idx;
    this.team = team;
    this.activeId = roster[idx].id;
    this.phase = "aim";
    this.timer = TURN_SECONDS;
    this.retreat = 0;
    this.shots = 0;
    this.moveDir = 0;
    const me = roster[idx];
    this.aim = me.facing === 1 ? -Math.PI / 4 : (-3 * Math.PI) / 4;
    if (this.ammo[team][this.weapon] === 0) this.weapon = "rocket";
    if (this.fixedWind !== undefined) this.wind = this.fixedWind;
    else {
      const prev = this.wind;
      do this.wind = Math.round((this.rand() * 2 - 1) * 100) / 100;
      while (Math.abs(this.wind - prev) < 0.05);
    }
    this.events.push({ t: "turn", team, active: this.activeId });
  }

  forfeit(seat: Seat): void {
    if (this.phase === "over") return;
    this.phase = "over";
    this.winner = (1 - seat) as Seat;
    this.projectiles = [];
  }
}
