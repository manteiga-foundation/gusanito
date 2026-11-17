import { COLOR_ORDER, DEFAULT_COLORS, PALETTE, WATER_Y, WEAPON_ORDER, WEAPONS, type ColorId, type WeaponId } from "../shared/constants.ts";
import type { GameEvent, LobbyPlayer, ProjView, Seat, ServerMsg, Snapshot, WormView } from "../shared/protocol.ts";
import { Terrain } from "../shared/terrain.ts";
import { Sfx } from "./audio.ts";
import { ICONS } from "./icons.ts";
import { Net } from "./net.ts";
import { Renderer, TEAM, type View } from "./render.ts";
import { leadText, standings } from "./standings.ts";

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
  private seat: Seat | null = null;
  private names: [string, string] = ["Player One", "Player Two"];
  private lobby: { players: [LobbyPlayer | null, LobbyPlayer | null]; wins: [number, number]; playing: boolean } | null = null;
  private inMatch = false;
  private prev: { s: Snapshot; t: number } | null = null;
  private cur: { s: Snapshot; t: number } | null = null;
  private myAim = -Math.PI / 4;
  private myPower = 0.65;
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
    // HUD treatment for who-is-winning; ?hud=bar|cards picks a candidate and is remembered
    const hudParam = new URLSearchParams(location.search).get("hud");
    if (hudParam === "bar" || hudParam === "cards") localStorage.setItem("wriggle.hud", hudParam);
    document.body.dataset.hud = localStorage.getItem("wriggle.hud") ?? "bar";
    document.querySelectorAll(".crown").forEach((el) => (el.innerHTML = ICONS.crown));
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
        this.seat = m.seat;
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
        this.startMatch(m.seat, m.names, Terrain.fromRLE(m.terrain.w, m.terrain.h, m.terrain.rle));
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
        err.textContent = m.reason === "full" ? "That match already has two players." : m.reason === "not-found" ? "No match with that code. Check it with your friend." : "Something went wrong. Try again.";
        if (m.reason === "not-found" && this.session) this.saveSession(null);
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
    const room = new URLSearchParams(location.search).get("room");
    if (room) {
      code.value = room.toUpperCase().slice(0, 4);
      $("#join").classList.add("primary");
      $("#create").classList.remove("primary");
    }
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
    name.addEventListener("keydown", (e) => e.key === "Enter" && (room ? join() : $("#create").click()));
  }

  private bindLobby(): void {
    $("#ready").addEventListener("click", () => {
      this.sfx.unlock();
      const me = this.seat !== null ? this.lobby?.players[this.seat] : null;
      this.net.send({ t: "ready", ready: !me?.ready });
    });
    if (!navigator.share) $("#invite").hidden = true;
    $("#invite").addEventListener("click", async () => {
      const me = this.seat !== null ? this.lobby?.players[this.seat]?.name : null;
      const code = this.session?.code ?? "";
      try {
        await navigator.share({ title: "Wriggle", text: `${me ? `${me} invites you to` : "Join"} a Wriggle match (code ${code}).`, url: this.inviteUrl() });
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
      history.replaceState(null, "", "/");
      this.r.setTerrain(Terrain.generate(2024));
      this.show("home");
    });
  }

  /** One source for team colours: CSS variables for the DOM, TEAM for the canvas. */
  private applyColors(colors: [ColorId, ColorId]): void {
    colors.forEach((c, i) => {
      const hex = PALETTE[c]?.hex ?? PALETTE[DEFAULT_COLORS[i]].hex;
      TEAM[i] = hex;
      document.documentElement.style.setProperty(i === 0 ? "--p1" : "--p2", hex);
    });
  }

  private renderSwatches(el: HTMLElement, mine: ColorId, theirs: ColorId | undefined, editable: boolean): void {
    const box = el.querySelector<HTMLElement>(".swatches")!;
    const key = editable ? `${mine}|${theirs ?? ""}` : "";
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
      b.setAttribute("aria-label", PALETTE[id].label + (id === theirs ? " (taken)" : ""));
      b.style.setProperty("--c", PALETTE[id].hex);
      b.disabled = id === theirs;
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
    $("#invite-link").textContent = this.inviteUrl().replace(/^https?:\/\//, "");
    this.applyColors([L.players[0]?.color ?? DEFAULT_COLORS[0], L.players[1]?.color ?? DEFAULT_COLORS[1]]);
    L.players.forEach((p, i) => {
      const el = $(`.seat[data-seat="${i}"]`);
      el.dataset.color = p?.color ?? "";
      const theirs = L.players[1 - i]?.color;
      this.renderSwatches(el, p?.color ?? DEFAULT_COLORS[i], theirs, !!p && i === this.seat && !L.playing);
      el.classList.toggle("empty", !p);
      el.classList.toggle("is-ready", !!p?.ready);
      el.classList.toggle("is-away", !!p && !p.connected);
      el.classList.toggle("is-me", i === this.seat);
      el.querySelector(".seat-name")!.textContent = p ? p.name : "Waiting for a player";
      el.querySelector(".seat-status")!.textContent = !p ? "Open seat" : !p.connected ? "Disconnected" : p.ready ? "Ready" : "Not ready";
    });
    $("#score").textContent = L.wins[0] + L.wins[1] > 0 ? `${L.wins[0]} : ${L.wins[1]}` : "vs";
    const me = this.seat !== null ? L.players[this.seat] : null;
    const ready = $("#ready");
    ready.textContent = me?.ready ? "Cancel ready" : L.wins[0] + L.wins[1] > 0 ? "Ready for a rematch" : "Ready";
    ready.classList.toggle("is-on", !!me?.ready);
    const other = this.seat !== null ? L.players[1 - this.seat] : null;
    $("#lobby-note").textContent = !other ? "Share the code with a friend. The match starts when both players are ready." : !other.ready ? `Waiting for ${other.name} to get ready.` : `${other.name} is ready. Tap Ready to start.`;
    // pause notice during a match
    const away = L.playing && L.players.some((p) => p && !p.connected);
    const paused = $("#paused");
    paused.hidden = !this.inMatch || !away;
    if (away) {
      const who = L.players.find((p) => p && !p.connected);
      paused.textContent = `${who?.name ?? "Opponent"} lost connection. Match paused.`;
    }
    if (!L.playing && this.inMatch && !this.overShown) {
      // the match ended while this client was not watching the result
      this.inMatch = false;
      this.show("lobby");
    }
  }

  // ---------- match ----------
  private startMatch(seat: Seat, names: [string, string], terrain: Terrain): void {
    this.seat = seat;
    this.names = names;
    this.inMatch = true;
    this.overShown = false;
    this.prev = null;
    this.cur = null;
    this.lastPhase = null;
    this.frozen = false;
    this.lastLeader = undefined;
    this.r.setTerrain(terrain);
    this.r.autoZoom = true;
    this.r.resize();
    $("#banner").hidden = true;
    $("#tray").hidden = true;
    document.querySelectorAll<HTMLElement>(".team").forEach((el, i) => (el.querySelector(".team-name")!.textContent = names[i]));
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

  private renderStandings(s: Snapshot): void {
    const st = standings(s);
    for (const team of [0, 1] as Seat[]) {
      const el = $(`.team.t${team}`);
      el.classList.toggle("leading", st.leader === team);
      el.classList.toggle("trailing", st.leader !== null && st.leader !== team);
      const total = el.querySelector(".team-total")!;
      if (total.textContent !== String(st.hp[team])) total.textContent = String(st.hp[team]);
      el.querySelector<HTMLElement>(".bar i")!.style.width = `${(100 * st.hp[team]) / (100 * Math.max(1, st.size[team]))}%`;
      const pips = s.worms.filter((w) => w.team === team).map((w) => `<i class="pip${w.alive ? " alive" : ""}"></i>`).join("");
      const box = el.querySelector(".pips")!;
      if (box.innerHTML !== pips) box.innerHTML = pips;
    }
    $<HTMLElement>("#tug .fill.t0").style.width = `${st.share * 100}%`;
    $<HTMLElement>("#tug .fill.t1").style.width = `${(1 - st.share) * 100}%`;
    const lead = $("#lead");
    lead.textContent = leadText(st, this.names, this.seat);
    lead.className = `lead ${st.leader === null ? "even" : `lead-${st.leader}`}`;
    if (this.lastLeader !== undefined && this.lastLeader !== st.leader) {
      void lead.offsetWidth;
      lead.classList.add("pulse");
    }
    this.lastLeader = st.leader;
  }

  private onGameEvent(e: GameEvent): void {
    const worms = this.cur?.s.worms ?? [];
    this.r.onEvent(e, worms);
    if (e.t === "boom") this.sfx.boom(e.r);
    else if (e.t === "fire") this.sfx.fire();
    else if (e.t === "drown" || e.t === "splash") this.sfx.splash();
    else if (e.t === "hurt" && worms.find((w) => w.id === e.id)?.team === this.seat) navigator.vibrate?.(60);
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
    $("#move-left").innerHTML = ICONS.left;
    $("#move-right").innerHTML = ICONS.right;
    $("#jump").innerHTML = ICONS.jump;
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
    const hold = (id: string, dir: -1 | 1) => {
      const el = $(id);
      const down = (e: PointerEvent) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add("down");
        this.net.send({ t: "move", dir });
      };
      const up = () => {
        if (!el.classList.contains("down")) return;
        el.classList.remove("down");
        this.net.send({ t: "move", dir: 0 });
      };
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      el.addEventListener("lostpointercapture", up);
    };
    hold("#move-left", -1);
    hold("#move-right", 1);
    $("#jump").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.net.send({ t: "jump" });
    });
    $("#fire").addEventListener("click", () => this.fire(this.myPower));
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

  private fire(power: number): void {
    const s = this.cur?.s;
    if (!s || s.phase !== "play" || !this.canAct(s) || this.mySeat(s).reload > 0) return;
    this.net.send({ t: "aim", angle: this.myAim });
    this.net.send({ t: "fire", power });
    $("#tray").hidden = true;
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

  private aimFrom(x: number, y: number): void {
    const w = this.activeWorm();
    if (!w) return;
    const s = this.r.toScreen(w.x, w.y);
    const dx = x - s.x;
    const dy = y - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 6) return;
    this.myAim = Math.atan2(dy, dx);
    this.myPower = Math.max(0.08, Math.min(1, (d - 20) / 180));
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
      else if (e.code === "Space") this.charge = performance.now();
      else if (/^Digit[1-4]$/.test(e.code)) this.chooseWeapon(WEAPON_ORDER[Number(e.code.slice(5)) - 1]);
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (!this.inMatch) return;
      const lr = ["ArrowLeft", "KeyA", "ArrowRight", "KeyD"];
      if (lr.includes(e.code) && !lr.some((k) => this.keys.has(k))) this.net.send({ t: "move", dir: 0 });
      if (e.code === "Space" && this.charge !== null) {
        const p = Math.min(1, (performance.now() - this.charge) / 1400);
        this.charge = null;
        this.myPower = Math.max(0.08, p);
        this.fire(this.myPower);
      }
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
    const charging = this.charge !== null ? Math.min(1, (performance.now() - this.charge) / 1400) : null;
    const aims: [number, number] = [cur.s.seats[0].aim, cur.s.seats[1].aim];
    if (this.seat !== null) aims[this.seat] = this.myAim;
    return {
      snap: cur.s,
      worms,
      proj,
      names: this.names,
      seat: this.seat,
      aims,
      actives: [cur.s.seats[0].active, cur.s.seats[1].active],
      power: live ? charging ?? this.myPower : null,
    };
  }

  private demoT = 0;
  private frame(dt: number): void {
    const v = this.viewNow();
    if (v) {
      // follow my latest shot while it flies, otherwise my worm
      const mine = v.proj.filter((q) => q.team === this.seat && q.k !== "bomblet");
      const p = mine[mine.length - 1];
      const w = this.activeWorm();
      if (p) this.r.follow(p.x, p.y, dt, 5);
      else if (w) this.r.follow(w.x, w.y, dt);
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
      preview: (s: Snapshot) => {
        this.frozen = true;
        this.prev = null;
        this.cur = { s, t: performance.now() };
        this.onState(s);
      },
      activeScreen: () => {
        const w = this.activeWorm();
        return w ? this.r.toScreen(w.x, w.y) : null;
      },
    };
  }
}

new App();
