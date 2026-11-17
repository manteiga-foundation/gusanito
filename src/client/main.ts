import { COLOR_ORDER, DEFAULT_COLORS, MAX_PLAYERS, PALETTE, WATER_Y, WEAPON_ORDER, WEAPONS, type ColorId, type WeaponId } from "../shared/constants.ts";
import type { GameEvent, LobbyPlayer, ProjView, Seat, ServerMsg, Snapshot, WormView } from "../shared/protocol.ts";
import { Terrain } from "../shared/terrain.ts";
import { Sfx } from "./audio.ts";
import { ICONS } from "./icons.ts";
import { Net } from "./net.ts";
import { Renderer, TEAM, type View } from "./render.ts";
import { leadText, standings } from "./standings.ts";
import { CHARGE_MS, Director, chargePower, charges } from "./director.ts";
import { soundsFor } from "./sounds.ts";
import { readStick } from "./stick.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

interface Session {
  code: string;
  token: string;
  seat: Seat;
}

const SESSION_KEY = "wriggle.session";
const NAME_KEY = "wriggle.name";

class App {
  private net: Net;
  private sfx = new Sfx();
  private r: Renderer;
  private session: Session | null = null;
  /** this player's team in the running match */
  private seat: Seat | null = null;
  /** this player's seat in the lobby (0..5) */
  private lobbySeat: number | null = null;
  private names: string[] = [];
  private lobby: { players: (LobbyPlayer | null)[]; wins: number[]; playing: boolean } | null = null;
  private inMatch = false;
  private prev: { s: Snapshot; t: number } | null = null;
  private cur: { s: Snapshot; t: number } | null = null;
  private myAim = -Math.PI / 4;
  private lastPower = 0;
  private director = new Director(null);
  private launchTimer = 0;
  private aimSentAt = 0;
  private aiming = false;
  private lastPhase: Snapshot["phase"] | null = null;
  private overShown = false;
  private wantsJoin: { kind: "create" | "join"; code?: string } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; mx: number; my: number } | null = null;
  private keys = new Set<string>();
  private charge: number | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private frozen = false;
  private lastLeader: Seat | null | undefined = undefined;
  private demoWells = [
    { x: 760, y: 260 },
    { x: 1330, y: 210 },
  ];

  constructor() {
    this.r = new Renderer($("#stage") as HTMLCanvasElement);
    this.r.setTerrain(Terrain.generate(2024));
    this.r.cam.y = 560;
    this.net = new Net(
      (m) => this.onMessage(m),
      () => this.onOpen(),
      (ok) => this.onStatus(ok),
    );
    this.session = this.loadSession();
    this.bindHome();
    this.bindLobby();
    this.bindHud();
    this.bindCanvas();
    this.bindKeys();
    window.addEventListener("resize", () => this.r.resize());
    this.net.connect();
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.frame(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    this.exposeForTests();
  }

  // ---------- session ----------
  private loadSession(): Session | null {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as Session | null;
      return s && typeof s.code === "string" && typeof s.token === "string" ? s : null;
    } catch {
      return null;
    }
  }
  private saveSession(s: Session | null): void {
    this.session = s;
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }
  private name(): string {
    const v = $<HTMLInputElement>("#name").value.trim();
    if (v) localStorage.setItem(NAME_KEY, v);
    return v;
  }

  // ---------- network ----------
  private onOpen(): void {
    const roomParam = new URLSearchParams(location.search).get("room")?.toUpperCase();
    if (this.session && (this.inMatch || this.lobby || roomParam === this.session.code)) {
      this.net.send({ t: "join", code: this.session.code, name: this.name(), token: this.session.token });
    } else if (this.wantsJoin) {
      this.sendWanted();
    }
  }

  private onStatus(ok: boolean): void {
    $("#conn").hidden = ok || (!this.inMatch && !this.lobby);
  }

  private sendWanted(): void {
    const w = this.wantsJoin;
    if (!w) return;
    if (w.kind === "create") this.net.send({ t: "create", name: this.name() });
    else this.net.send({ t: "join", code: w.code!, name: this.name(), token: this.session && this.session.code === w.code ? this.session.token : undefined });
  }

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case "joined":
        this.wantsJoin = null;
        this.lobbySeat = m.seat;
        this.saveSession({ code: m.code, token: m.token, seat: m.seat });
        history.replaceState(null, "", `/?room=${m.code}`);
        $("#room-code").textContent = m.code;
        if (!this.inMatch) this.show("lobby");
        break;
      case "lobby":
        this.lobby = { players: m.players, wins: m.wins, playing: m.playing };
        this.renderLobby();
        break;
      case "start":
        this.applyColors(m.colors);
        this.startMatch(m.team, m.names, Terrain.fromRLE(m.terrain.w, m.terrain.h, m.terrain.rle));
        break;
      case "state":
        if (this.frozen) break;
        this.prev = this.cur;
        this.cur = { s: m.s, t: performance.now() };
        this.onState(m.s);
        break;
      case "events":
        for (const e of m.list) this.onGameEvent(e);
        break;
      case "error": {
        this.wantsJoin = null;
        const err = $("#home-error");
        err.hidden = false;
        err.textContent = m.reason === "full" ? `That match is full (${MAX_PLAYERS} players).` : m.reason === "not-found" ? "No match with that code. Check it with your friend." : "Something went wrong. Try again.";
        if (m.reason === "not-found" && this.session) this.saveSession(null);
        if (this.invited) {
          this.setInvited(null);
          history.replaceState(null, "", "/");
        }
        this.show("home");
        break;
      }
    }
  }

  // ---------- screens ----------
  private show(which: "home" | "lobby" | "hud"): void {
    $("#home").hidden = which !== "home";
    $("#lobby").hidden = which !== "lobby";
    $("#hud").hidden = which !== "hud";
  }

  private bindHome(): void {
    const name = $<HTMLInputElement>("#name");
    name.value = localStorage.getItem(NAME_KEY) ?? "";
    const code = $<HTMLInputElement>("#code");
    const room = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
    if (/^[A-Z]{4}$/.test(room)) this.setInvited(room);
    $("#join-cta").addEventListener("click", () => {
      this.sfx.unlock();
      this.wantsJoin = { kind: "join", code: code.value };
      if (this.net.connected) this.sendWanted();
    });
    $("#create-instead").addEventListener("click", () => {
      this.setInvited(null);
      history.replaceState(null, "", "/");
    });
    code.addEventListener("input", () => (code.value = code.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4)));
    $("#create").addEventListener("click", () => {
      this.sfx.unlock();
      this.wantsJoin = { kind: "create" };
      if (this.net.connected) this.sendWanted();
    });
    const join = () => {
      this.sfx.unlock();
      const c = code.value.trim().toUpperCase();
      if (c.length !== 4) {
        const err = $("#home-error");
        err.hidden = false;
        err.textContent = "Enter the four-letter match code.";
        code.focus();
        return;
      }
      this.wantsJoin = { kind: "join", code: c };
      if (this.net.connected) this.sendWanted();
    };
    $("#join").addEventListener("click", join);
    code.addEventListener("keydown", (e) => e.key === "Enter" && join());
    name.addEventListener("keydown", (e) => e.key === "Enter" && (this.invited ? $("#join-cta").click() : $("#create").click()));
  }

  private invited = false;

  /** Opened from an invite link: Join leads, creating a new match steps back to a quiet link. */
  private setInvited(code: string | null): void {
    this.invited = code !== null;
    $<HTMLInputElement>("#code").value = code ?? "";
    const cta = $("#join-cta");
    cta.hidden = !this.invited;
    cta.textContent = `Join match ${code ?? ""}`;
    $("#create").hidden = this.invited;
    $(".home-panel .or").hidden = this.invited;
    $(".home-panel .join-row").hidden = this.invited;
    $("#create-instead").hidden = !this.invited;
    // the server names the host in the page's preview title
    const host = document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.match(/^(.+) invites you to Gusanito$/)?.[1];
    $("#home-eyebrow").textContent = this.invited && host ? `${host} invites you` : this.invited ? "You are invited" : "Artillery for 2 to 6 players";
  }

  private bindLobby(): void {
    $("#ready").addEventListener("click", () => {
      this.sfx.unlock();
      const me = this.lobbySeat !== null ? this.lobby?.players[this.lobbySeat] : null;
      this.net.send({ t: "ready", ready: !me?.ready });
    });
    if (!navigator.share) $("#invite").hidden = true;
    $("#invite").addEventListener("click", async () => {
      const me = this.lobbySeat !== null ? this.lobby?.players[this.lobbySeat]?.name : null;
      const code = this.session?.code ?? "";
      try {
        await navigator.share({ title: "Gusanito", text: `${me ? `${me} invites you to` : "Join"} a Gusanito match (code ${code}).`, url: this.inviteUrl() });
      } catch {
        /* share sheet dismissed */
      }
    });
    $("#copy-link").addEventListener("click", async () => {
      const btn = $("#copy-link");
      const url = this.inviteUrl();
      let ok = false;
      try {
        await navigator.clipboard.writeText(url);
        ok = true;
      } catch {
        // older browsers: copy from a selection
        const range = document.createRange();
        range.selectNodeContents($("#invite-link"));
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        ok = document.execCommand("copy");
      }
      btn.textContent = ok ? "Copied" : "Select and copy";
      setTimeout(() => (btn.textContent = "Copy"), 1800);
    });
    $("#leave").addEventListener("click", () => {
      this.net.send({ t: "leave" });
      this.saveSession(null);
      this.lobby = null;
      this.inMatch = false;
      this.seat = null;
      this.lobbySeat = null;
      history.replaceState(null, "", "/");
      this.r.setTerrain(Terrain.generate(2024));
      this.show("home");
    });
  }

  /** Team colours for the match: TEAM for the canvas; DOM pieces take theirs inline. */
  private applyColors(colors: ColorId[]): void {
    colors.forEach((c, i) => (TEAM[i] = PALETTE[c]?.hex ?? PALETTE[DEFAULT_COLORS[i]].hex));
  }

  private renderSwatches(mine: ColorId, taken: Set<ColorId>, editable: boolean): void {
    const row = $("#my-colors");
    row.hidden = !editable;
    const box = row.querySelector<HTMLElement>(".swatches")!;
    const key = editable ? `${mine}|${[...taken].join(",")}` : "";
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = "";
    if (!editable) return;
    for (const id of COLOR_ORDER) {
      const b = document.createElement("button");
      b.className = "swatch";
      b.dataset.color = id;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(id === mine));
      b.setAttribute("aria-label", PALETTE[id].label + (taken.has(id) ? " (taken)" : ""));
      b.style.setProperty("--c", PALETTE[id].hex);
      b.disabled = taken.has(id);
      b.addEventListener("click", () => {
        if (id !== mine) this.net.send({ t: "color", color: id });
        this.sfx.blip(520 + COLOR_ORDER.indexOf(id) * 60);
      });
      box.appendChild(b);
    }
  }

  private inviteUrl(): string {
    return `${location.origin}/?room=${this.session?.code ?? ""}`;
  }

  private renderLobby(): void {
    const L = this.lobby!;
    const ORDINAL = ["One", "Two", "Three", "Four", "Five", "Six"];
    $("#invite-link").textContent = this.inviteUrl().replace(/^https?:\/\//, "");
    const seated = L.players.map((p, i) => ({ p, i })).filter((x) => x.p);
    const open = L.players.findIndex((p) => !p);
    const cards = [...seated.map((x) => x.i), ...(open >= 0 && !L.playing ? [open] : [])];
    const box = $("#seats");
    box.innerHTML = "";
    for (const i of cards) {
      const p = L.players[i];
      const el = document.createElement("article");
      el.className = "seat";
      el.dataset.seat = String(i);
      el.dataset.color = p?.color ?? "";
      if (p) el.style.setProperty("--c", PALETTE[p.color].hex);
      el.classList.toggle("open", !p);
      el.classList.toggle("is-ready", !!p?.ready);
      el.classList.toggle("is-away", !!p && !p.connected);
      el.classList.toggle("is-waiting", !!p && L.playing && !p.inMatch);
      el.classList.toggle("is-me", i === this.lobbySeat);
      const status = !p ? "Open seat" : !p.connected ? "Disconnected" : L.playing ? (p.inMatch ? "Playing" : "Next round") : p.ready ? "Ready" : "Not ready";
      const wins = L.wins[i] ?? 0;
      el.innerHTML = `<div class="seat-title">Ready Player <b>${ORDINAL[i]}</b></div><div class="seat-name"></div><div class="seat-status">${status}</div>${wins ? `<div class="seat-wins">${wins} ${wins === 1 ? "win" : "wins"}</div>` : ""}`;
      el.querySelector(".seat-name")!.textContent = p ? p.name : "Invite a friend";
      box.appendChild(el);
    }
    const me = this.lobbySeat !== null ? L.players[this.lobbySeat] : null;
    const taken = new Set(L.players.filter((p, i) => p && i !== this.lobbySeat).map((p) => p!.color));
    this.renderSwatches(me?.color ?? "coral", taken, !!me && !L.playing);
    const ready = $<HTMLButtonElement>("#ready");
    const anyWins = L.wins.some((w) => w > 0);
    ready.disabled = L.playing;
    ready.textContent = L.playing ? "A round is on" : me?.ready ? "Cancel ready" : anyWins ? "Ready for a rematch" : "Ready";
    ready.classList.toggle("is-on", !!me?.ready);
    const others = seated.filter((x) => x.i !== this.lobbySeat).map((x) => x.p!);
    const waitingOn = others.filter((p) => !p.ready);
    $("#lobby-note").textContent = L.playing
      ? "A round is on. You join the next one."
      : others.length === 0
        ? `Share the link. Up to ${MAX_PLAYERS} players; the match starts when everyone here is ready.`
        : waitingOn.length
          ? `Waiting for ${waitingOn.map((p) => p.name).join(", ")} to get ready.`
          : "Everyone else is ready. Tap Ready to start.";
    // pause notice during a match
    const away = L.playing && L.players.some((p) => p && p.inMatch && !p.connected);
    const paused = $("#paused");
    paused.hidden = !this.inMatch || !away;
    if (away) {
      const who = L.players.find((p) => p && p.inMatch && !p.connected);
      paused.textContent = `${who?.name ?? "A player"} lost connection. Match paused.`;
    }
    if (!L.playing && this.inMatch && !this.overShown) {
      // the match ended while this client was not watching the result
      this.inMatch = false;
      this.show("lobby");
    }
  }

  // ---------- match ----------
  private startMatch(seat: Seat, names: string[], terrain: Terrain): void {
    this.seat = seat;
    this.names = names;
    this.inMatch = true;
    this.overShown = false;
    this.prev = null;
    this.cur = null;
    this.lastPhase = null;
    this.director.setSeat(seat);
    this.frozen = false;
    this.lastLeader = undefined;
    this.r.setTerrain(terrain);
    this.r.autoZoom = true;
    this.r.resize();
    $("#banner").hidden = true;
    $("#tray").hidden = true;
    this.buildBoard(names);
    this.show("hud");
    void this.requestWakeLock();
  }

  /** Both players act at once: you can act whenever the match is on and your worm stands. */
  private canAct(s: Snapshot | undefined = this.cur?.s): boolean {
    if (!s || !this.inMatch || this.seat === null || s.phase === "over") return false;
    const me = s.worms.find((w) => w.id === s.seats[this.seat!].active);
    return !!me && me.alive;
  }

  private mySeat(s: Snapshot) {
    return s.seats[this.seat ?? 0];
  }

  private onState(s: Snapshot): void {
    if (!this.inMatch) return;
    this.r.wind = s.wind;
    const me = this.mySeat(s);
    const live = this.canAct(s);
    if (this.lastPhase === null) this.myAim = me.aim;
    if (this.lastPhase === "countdown" && s.phase === "play") {
      this.sfx.turn();
      navigator.vibrate?.(35);
    }
    this.lastPhase = s.phase;
    if (!this.aiming && performance.now() - this.aimSentAt > 400) this.myAim = me.aim;

    const label = $("#turn-label");
    const rising = s.phase === "play" && s.waterY < WATER_Y;
    label.textContent = s.phase === "countdown" ? `Starting in ${s.countdown}` : rising ? "Water rising" : "";
    label.hidden = label.textContent === "";
    label.classList.toggle("mine", s.phase === "countdown");
    label.classList.toggle("warn", rising);
    $("#timer").textContent = `${Math.floor(s.clock / 60)}:${String(s.clock % 60).padStart(2, "0")}`;
    $(".clock").classList.toggle("urgent", s.phase === "play" && s.clock <= 30);
    const fireBtn = $("#fire");
    fireBtn.classList.toggle("reloading", me.reload > 0);
    fireBtn.style.setProperty("--reload", String(me.reloadOf > 0 ? me.reload / me.reloadOf : 0));
    const wind = $(".wind-bar i");
    const pct = Math.abs(s.wind) * 50;
    wind.style.width = `${pct}%`;
    wind.style.left = s.wind >= 0 ? "50%" : `${50 - pct}%`;
    this.renderStandings(s);
    const hud = $("#hud");
    hud.classList.toggle("idle", !live);
    hud.classList.toggle("counting", s.phase === "countdown");
    const wbtn = $("#weapon");
    if (wbtn.dataset.w !== me.weapon) {
      wbtn.innerHTML = `${ICONS[me.weapon]}<span>${WEAPONS[me.weapon].label}</span>`;
      wbtn.dataset.w = me.weapon;
      fireBtn.dataset.weapon = me.weapon;
      fireBtn.innerHTML = `<span class="fire-icon">${ICONS[me.weapon]}</span><span class="fire-label">Fire</span>`;
    }
    if (!live) $("#tray").hidden = true;

    if (s.phase === "over" && !this.overShown) {
      this.overShown = true;
      const timeUp = s.clock <= 0;
      setTimeout(() => {
        $("#banner").hidden = false;
        $("#banner-title").textContent = s.winner === -1 ? "A draw" : s.winner === this.seat ? "You win" : `${this.names[s.winner as Seat]} wins`;
        $("#banner-sub").textContent = timeUp ? "Decided on health at the final whistle" : "Last team standing";
      }, 1200);
    }
  }

  /** One row per team on the board and one segment per team in the shared bar. */
  private buildBoard(names: string[]): void {
    const board = $("#board");
    const tug = $("#tug");
    board.innerHTML = "";
    tug.innerHTML = "";
    names.forEach((name, t) => {
      const row = document.createElement("li");
      row.className = "row" + (t === this.seat ? " is-me" : "");
      row.dataset.team = String(t);
      row.style.setProperty("--tone", TEAM[t]);
      row.innerHTML = `<span class="rank"></span><span class="crown">${ICONS.crown}</span><span class="team-name"></span><span class="team-total">300</span><span class="pips"></span>`;
      row.querySelector(".crown")!.remove();
      row.querySelector(".rank")!.innerHTML = `<span class="crown">${ICONS.crown}</span><span class="n"></span>`;
      row.querySelector(".team-name")!.textContent = t === this.seat ? `${name} (you)` : name;
      board.appendChild(row);
      const seg = document.createElement("i");
      seg.className = "seg";
      seg.dataset.team = String(t);
      seg.style.setProperty("--tone", TEAM[t]);
      tug.appendChild(seg);
    });
  }

  private renderStandings(s: Snapshot): void {
    const st = standings(s, this.names.length);
    st.order.forEach((team, rank) => {
      const row = document.querySelector<HTMLElement>(`.row[data-team="${team}"]`);
      if (!row) return;
      row.style.order = String(rank);
      row.classList.toggle("leading", st.leader === team);
      row.classList.toggle("out", st.alive[team] === 0);
      row.querySelector(".n")!.textContent = String(rank + 1);
      const total = row.querySelector(".team-total")!;
      if (total.textContent !== String(st.hp[team])) total.textContent = String(st.hp[team]);
      const pips = s.worms.filter((w) => w.team === team).map((w) => `<i class="pip${w.alive ? " alive" : ""}"></i>`).join("");
      const box = row.querySelector(".pips")!;
      if (box.innerHTML !== pips) box.innerHTML = pips;
    });
    st.share.forEach((sh, t) => {
      const seg = document.querySelector<HTMLElement>(`#tug .seg[data-team="${t}"]`);
      if (seg) seg.style.width = `${sh * 100}%`;
    });
    const lead = $("#lead");
    lead.textContent = leadText(st, this.names, this.seat);
    lead.className = "lead";
    if (st.leader !== null) lead.style.setProperty("--tone", TEAM[st.leader]);
    else lead.style.removeProperty("--tone");
    if (this.lastLeader !== undefined && this.lastLeader !== st.leader) {
      void lead.offsetWidth;
      lead.classList.add("pulse");
    }
    this.lastLeader = st.leader;
  }

  private onGameEvent(e: GameEvent): void {
    const worms = this.cur?.s.worms ?? [];
    this.r.onEvent(e, worms);
    this.director.onEvent(e, performance.now());
    for (const cue of soundsFor(e, this.seat, worms)) {
      if (cue === "boom" && e.t === "boom") this.sfx.boom(e.r);
      else if (cue === "fire") this.sfx.fire();
      else if (cue === "splash") this.sfx.splash();
      else if (cue === "death" || cue === "death-own") {
        // the puff lands after the splash when a worm drowns
        setTimeout(() => this.sfx.death(cue === "death-own"), e.t === "drown" ? 250 : 0);
        if (cue === "death-own") navigator.vibrate?.([80, 60, 140]);
      }
    }
    if (e.t === "hurt" && worms.find((w) => w.id === e.id)?.team === this.seat) navigator.vibrate?.(60);
    else if (e.t === "switch" && e.seat === this.seat) {
      this.sfx.blip(700, 0.06, 0.08);
      this.r.manualUntil = 0;
    }
  }

  private renderTray(s: Snapshot): void {
    const grid = $(".tray-grid");
    grid.innerHTML = "";
    for (const id of WEAPON_ORDER) {
      const b = document.createElement("button");
      const me = this.mySeat(s);
      b.className = "tray-item" + (me.weapon === id ? " on" : "");
      b.dataset.weapon = id;
      const ammo = me.ammo[id];
      b.disabled = ammo === 0;
      b.innerHTML = `${ICONS[id]}<span>${WEAPONS[id].label}</span>${ammo >= 0 ? `<span class="ammo">x${ammo}</span>` : ""}`;
      b.addEventListener("click", () => this.chooseWeapon(id));
      grid.appendChild(b);
    }
  }

  private chooseWeapon(id: WeaponId): void {
    this.net.send({ t: "weapon", id });
    $("#tray").hidden = true;
    this.sfx.blip(440);
  }

  private bindHud(): void {
    if (localStorage.getItem("wriggle.aimed")) $("#aim-hint").hidden = true;
    $("#fullscreen").innerHTML = ICONS.fullscreen;
    const sound = $("#sound");
    sound.innerHTML = this.sfx.muted ? ICONS.soundOff : ICONS.soundOn;
    sound.addEventListener("click", () => (sound.innerHTML = this.sfx.toggle() ? ICONS.soundOff : ICONS.soundOn));
    const fs = $("#fullscreen");
    if (!document.fullscreenEnabled) fs.hidden = true;
    fs.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else
        void document.documentElement
          .requestFullscreen?.()
          .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => {}));
    });
    this.bindStick();
    // Fire: press and hold to build speed, release to shoot (hitscan weapons shoot on release)
    const fire = $("#fire");
    fire.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      fire.setPointerCapture(e.pointerId);
      this.startCharge();
    });
    fire.addEventListener("pointerup", () => this.releaseCharge());
    fire.addEventListener("pointercancel", () => this.cancelCharge());
    fire.addEventListener("contextmenu", (e) => e.preventDefault());
    $("#weapon").addEventListener("click", () => {
      const tray = $("#tray");
      tray.hidden = !tray.hidden;
      if (!tray.hidden && this.cur) this.renderTray(this.cur.s);
    });
    $("#rematch").addEventListener("click", () => {
      $("#banner").hidden = true;
      this.inMatch = false;
      this.wakeLock?.release().catch(() => {});
      this.show("lobby");
      if (this.lobby) this.renderLobby();
    });
    for (const sel of ["#hud", "#lobby"]) $(sel).addEventListener("contextmenu", (e) => e.preventDefault());
  }

  /** One thumb control: sideways walks, a push up jumps (once per push), release stops. */
  private bindStick(): void {
    const stick = $("#stick");
    let origin: { x: number; y: number } | null = null;
    let armed = true;
    let dir: -1 | 0 | 1 = 0;
    const knob = (x: number, y: number) => {
      stick.style.setProperty("--kx", `${x}px`);
      stick.style.setProperty("--ky", `${y}px`);
    };
    const update = (e: PointerEvent) => {
      if (!origin) return;
      const r = readStick(e.clientX - origin.x, e.clientY - origin.y, armed);
      armed = r.armed;
      knob(r.kx, r.ky);
      if (r.dir !== dir) {
        dir = r.dir;
        this.net.send({ t: "move", dir });
      }
      if (r.jump) {
        this.net.send({ t: "jump" });
        stick.classList.add("jumped");
        setTimeout(() => stick.classList.remove("jumped"), 160);
      }
    };
    const end = () => {
      if (!origin) return;
      origin = null;
      armed = true;
      stick.classList.remove("active");
      knob(0, 0);
      if (dir !== 0) {
        dir = 0;
        this.net.send({ t: "move", dir: 0 });
      }
    };
    stick.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      stick.setPointerCapture(e.pointerId);
      const r = stick.getBoundingClientRect();
      origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      stick.classList.add("active");
      update(e);
    });
    stick.addEventListener("pointermove", update);
    stick.addEventListener("pointerup", end);
    stick.addEventListener("pointercancel", end);
    stick.addEventListener("lostpointercapture", end);
  }

  private ready(): boolean {
    const s = this.cur?.s;
    return !!s && s.phase === "play" && this.canAct(s) && this.mySeat(s).reload <= 0;
  }

  private startCharge(): void {
    if (!this.ready() || this.charge !== null) return;
    this.charge = performance.now();
    $("#tray").hidden = true;
    const fire = $("#fire");
    fire.classList.remove("launch");
    fire.classList.add("charging");
    this.sfx.blip(300, 0.05, 0.05);
  }

  private chargeLevel(): number {
    if (this.charge === null) return 0;
    const w = this.cur ? this.mySeat(this.cur.s).weapon : "rocket";
    return charges(w) ? chargePower(performance.now() - this.charge) : 1;
  }

  private releaseCharge(): void {
    if (this.charge === null) return;
    const power = this.chargeLevel();
    this.charge = null;
    this.fire(power);
  }

  private cancelCharge(): void {
    this.charge = null;
    const fire = $("#fire");
    fire.classList.remove("charging");
    fire.style.setProperty("--charge", "0");
  }

  private fire(power: number): void {
    const fire = $("#fire");
    fire.classList.remove("charging");
    fire.style.setProperty("--charge", "0");
    if (!this.ready()) return;
    this.lastPower = power;
    this.net.send({ t: "aim", angle: this.myAim });
    this.net.send({ t: "fire", power });
    $("#tray").hidden = true;
    fire.classList.add("launch");
    clearTimeout(this.launchTimer);
    this.launchTimer = window.setTimeout(() => fire.classList.remove("launch"), 380);
  }

  private sendAim(force = false): void {
    const now = performance.now();
    if (!force && now - this.aimSentAt < 50) return;
    this.aimSentAt = now;
    this.net.send({ t: "aim", angle: this.myAim });
  }

  // ---------- canvas gestures ----------
  private activeWorm(): WormView | undefined {
    const v = this.viewNow();
    return v && this.seat !== null ? v.worms.find((w) => w.id === v.snap.seats[this.seat!].active) : undefined;
  }

  private ownWormAt(x: number, y: number): number | null {
    const v = this.viewNow();
    if (!v || this.seat === null) return null;
    let best: number | null = null;
    let bestD = 30;
    for (const w of v.worms) {
      if (w.team !== this.seat || !w.alive || w.id === v.snap.seats[this.seat].active) continue;
      const s = this.r.toScreen(w.x, w.y);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = w.id;
      }
    }
    return best;
  }

  private aimFrom(x: number, y: number): void {
    const w = this.activeWorm();
    if (!w) return;
    const s = this.r.toScreen(w.x, w.y);
    const dx = x - s.x;
    const dy = y - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 6) return;
    this.myAim = Math.atan2(dy, dx);
    this.sendAim();
    if (!localStorage.getItem("wriggle.aimed")) {
      localStorage.setItem("wriggle.aimed", "1");
      $("#aim-hint").hidden = true;
    }
  }

  private bindCanvas(): void {
    const cv = this.r.canvas;
    cv.addEventListener("pointerdown", (e) => {
      $("#tray").hidden = true;
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        this.aiming = false;
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      } else if (this.pointers.size === 1 && this.canAct()) {
        // tapping another of my worms takes control of it; anywhere else aims
        const pick = this.ownWormAt(e.clientX, e.clientY);
        if (pick !== null) {
          this.net.send({ t: "select", id: pick });
          this.sfx.blip(620, 0.05, 0.08);
          return;
        }
        this.aiming = true;
        this.aimFrom(e.clientX, e.clientY);
      }
    });
    cv.addEventListener("pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size >= 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        this.r.zoomAt(d / this.pinch.d, mx, my);
        this.r.pan(mx - this.pinch.mx, my - this.pinch.my);
        this.pinch = { d, mx, my };
      } else if (this.aiming) this.aimFrom(e.clientX, e.clientY);
      else if (this.inMatch) this.r.pan(dx, dy);
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.aiming && this.pointers.size === 0) {
        this.aiming = false;
        this.sendAim(true);
      }
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (this.inMatch) this.r.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      },
      { passive: false },
    );
  }

  private bindKeys(): void {
    const aimKeys = ["ArrowUp", "KeyW", "ArrowDown", "KeyS"];
    window.addEventListener("keydown", (e) => {
      if (!this.inMatch || (e.target as HTMLElement).tagName === "INPUT") return;
      if (this.keys.has(e.code) && !aimKeys.includes(e.code)) return;
      this.keys.add(e.code);
      const left = e.code === "ArrowLeft" || e.code === "KeyA";
      const right = e.code === "ArrowRight" || e.code === "KeyD";
      if (left || right) this.net.send({ t: "move", dir: left ? -1 : 1 });
      else if (aimKeys.includes(e.code)) {
        const up = e.code === "ArrowUp" || e.code === "KeyW";
        const facing = Math.cos(this.myAim) >= 0 ? 1 : -1;
        this.myAim += (up ? -1 : 1) * facing * 0.045;
        this.sendAim();
      } else if (e.code === "Enter" || e.code === "KeyJ") this.net.send({ t: "jump" });
      else if (e.code === "Space") this.startCharge();
      else if (/^Digit[1-4]$/.test(e.code)) this.chooseWeapon(WEAPON_ORDER[Number(e.code.slice(5)) - 1]);
      else if (e.code === "Tab") {
        // Tab: control my next living worm
        e.preventDefault();
        const s = this.cur?.s;
        if (s && this.seat !== null) {
          const mine = s.worms.filter((w) => w.team === this.seat && w.alive);
          const at = mine.findIndex((w) => w.id === s.seats[this.seat!].active);
          const next = mine[(at + 1) % mine.length];
          if (next) this.net.send({ t: "select", id: next.id });
        }
      }
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (!this.inMatch) return;
      const lr = ["ArrowLeft", "KeyA", "ArrowRight", "KeyD"];
      if (lr.includes(e.code) && !lr.some((k) => this.keys.has(k))) this.net.send({ t: "move", dir: 0 });
      if (e.code === "Space") this.releaseCharge();
    });
  }

  private async requestWakeLock(): Promise<void> {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl) this.wakeLock = await wl.request("screen");
    } catch {
      /* not granted */
    }
  }

  // ---------- frame ----------
  private viewNow(): View | null {
    if (!this.cur || !this.inMatch) return null;
    const cur = this.cur;
    const prev = this.prev ?? cur;
    const span = Math.max(16, cur.t - prev.t);
    const a = Math.max(0, Math.min(1, (performance.now() - cur.t) / span));
    const lerp = (p: number, q: number) => p + (q - p) * a;
    const pw = new Map(prev.s.worms.map((w) => [w.id, w]));
    const worms = cur.s.worms.map((w) => {
      const o = pw.get(w.id);
      return o && Math.hypot(o.x - w.x, o.y - w.y) < 120 ? { ...w, x: lerp(o.x, w.x), y: lerp(o.y, w.y) } : w;
    });
    const pp = new Map(prev.s.proj.map((p) => [p.id, p]));
    const proj: ProjView[] = cur.s.proj.map((p) => {
      const o = pp.get(p.id);
      return o ? { ...p, x: lerp(o.x, p.x), y: lerp(o.y, p.y) } : p;
    });
    const live = this.canAct(cur.s);

    const aims = cur.s.seats.map((x) => x.aim);
    if (this.seat !== null) aims[this.seat] = this.myAim;
    return {
      snap: cur.s,
      worms,
      proj,
      names: this.names,
      seat: this.seat,
      aims,
      actives: cur.s.seats.map((x) => x.active),
      power: live ? this.chargeLevel() : null,
    };
  }

  private demoT = 0;
  private frame(dt: number): void {
    const v = this.viewNow();
    if (v) {
      // my shot while it flies, its blast for a moment, then my next worm
      const t = this.director.target(v, performance.now());
      if (t) this.r.follow(t.x, t.y, dt, t.rate);
      if (this.charge !== null) {
        const c = this.chargeLevel();
        const fire = $("#fire");
        fire.style.setProperty("--charge", c.toFixed(3));
        fire.style.setProperty("--heat", `hsl(${Math.round(48 - 46 * c)} 100% ${Math.round(62 - 8 * c)}%)`);
        if (!this.ready()) this.cancelCharge();
        else if (c >= 1 && performance.now() - this.charge >= CHARGE_MS + 120) this.releaseCharge();
      }
      this.r.draw(dt, v, v.snap.wells, v.snap.waterY);
    } else {
      this.demoT += dt;
      this.r.cam.x = 1000 + Math.sin(this.demoT * 0.06) * 520;
      // keep the waterline low on tall portrait screens
      this.r.cam.y = Math.min(560, 950 - (this.r.height * 0.3) / this.r.cam.zoom);
      this.r.wind = 0.4;
      this.r.draw(dt, null, this.demoWells, 940);
    }
  }

  private exposeForTests(): void {
    (window as unknown as Record<string, unknown>).__wriggle = {
      snapshot: () => this.cur?.s ?? null,
      seat: () => this.seat,
      connected: () => this.net.connected,
      dropConnection: () => this.net.drop(),
      /** test and design hook: stop applying live state and show this snapshot instead */
      teamColors: () => [...TEAM],
      lastFirePower: () => this.lastPower,
      /** render a cue offline and measure it: peak level and audible length in seconds */
      renderCue: async (cue: "death" | "death-own" | "boom") => {
        const ctx = new OfflineAudioContext(1, 44100 * 2, 44100);
        const s = new Sfx();
        s.useContext(ctx);
        if (cue === "boom") s.boom(40);
        else s.death(cue === "death-own");
        const buf = await ctx.startRendering();
        const d = buf.getChannelData(0);
        let peak = 0;
        let last = 0;
        for (let i = 0; i < d.length; i++) {
          const a = Math.abs(d[i]);
          if (a > peak) peak = a;
          if (a > 0.01) last = i;
        }
        return { peak, seconds: last / buf.sampleRate };
      },
      preview: (s: Snapshot) => {
        this.frozen = true;
        this.prev = null;
        this.cur = { s, t: performance.now() };
        this.onState(s);
      },
      wormScreen: (id: number) => {
        const w = this.viewNow()?.worms.find((x) => x.id === id);
        return w ? this.r.toScreen(w.x, w.y) : null;
      },
      lookAt: (id: number) => {
        const w = this.viewNow()?.worms.find((x) => x.id === id);
        if (!w) return;
        this.r.cam.x = w.x;
        this.r.cam.y = w.y - 40;
        this.r.manualUntil = performance.now() + 3000;
      },
      activeScreen: () => {
        const w = this.activeWorm();
        return w ? this.r.toScreen(w.x, w.y) : null;
      },
    };
  }
}

new App();
