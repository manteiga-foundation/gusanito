import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, devices, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { startServer } from "../../src/server/server.ts";

const SHOTS = process.env.SHOTS_DIR ?? "test-results";
mkdirSync(SHOTS, { recursive: true });

let server: ReturnType<typeof startServer> | undefined;
let browser: Browser;
let url = "";
const errors: string[] = [];

// A phone held in landscape: the layout the game is designed for.
const phone = { ...devices["iPhone 13"], viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true };
const portrait = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

beforeAll(async () => {
  // BASE_URL runs the same flow against a deployed instance (e.g. https://wriggle-game.fly.dev)
  if (process.env.BASE_URL) url = process.env.BASE_URL.replace(/\/$/, "");
  else {
    server = startServer({ port: 0, staticDir: "dist", hostname: "127.0.0.1" });
    url = `http://127.0.0.1:${server.port}`;
  }
  // HOST_RULES pins a hostname for a run whose local DNS cache is stale, e.g. "MAP gusanito.manteiga.org 66.241.124.50"
  browser = await chromium.launch({ args: process.env.HOST_RULES ? [`--host-resolver-rules=${process.env.HOST_RULES}`] : [] });
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function open(device = phone, path = "/"): Promise<Page> {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url + path);
  return page;
}

const snap = (p: Page) => p.evaluate(() => (window as any).__wriggle.snapshot());

test("home screen offers create and join on a phone", async () => {
  const p = await open();
  await expect(p.locator("#create").isVisible()).resolves.toBe(true);
  await expect(p.locator("#join").isVisible()).resolves.toBe(true);
  const box = (await p.locator("#create").boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await p.textContent(".wordmark")).toBe("Gusanito");
  expect(await p.title()).toContain("Gusanito");
  await p.screenshot({ path: `${SHOTS}/home-landscape.png` });
  // the death cues render, are audible, and the own-worm one is the longer, lower one
  const other = await p.evaluate(() => (window as any).__wriggle.renderCue("death"));
  const own = await p.evaluate(() => (window as any).__wriggle.renderCue("death-own"));
  expect(other.peak).toBeGreaterThan(0.05);
  expect(other.seconds).toBeGreaterThan(0.4);
  expect(own.seconds).toBeGreaterThan(other.seconds);
  await p.context().close();
  const q = await open(portrait);
  await q.screenshot({ path: `${SHOTS}/home-portrait.png` });
  await q.context().close();
});

test("two phones meet in the Ready Player One / Two lobby and play at the same time", async () => {
  const a = await open();
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();
  expect(code).toMatch(/^[A-Z]{4}$/);

  const b = await open(phone, `/?room=${code}`);
  await b.fill("#name", "Bo");
  await b.tap("#join-cta");
  await b.waitForSelector("#lobby:not([hidden])");

  for (const p of [a, b]) {
    await p.waitForFunction(() => document.querySelector('[data-seat="1"] .seat-name')?.textContent === "Bo");
    expect(await p.textContent('[data-seat="0"] .seat-title')).toBe("Ready Player One");
    expect(await p.textContent('[data-seat="1"] .seat-title')).toBe("Ready Player Two");
    expect(await p.textContent('[data-seat="0"] .seat-name')).toBe("Ada");
  }
  await a.tap("#ready");
  await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.classList.contains("is-ready"));
  await a.screenshot({ path: `${SHOTS}/lobby-one-ready.png` });
  await b.tap("#ready");

  for (const p of [a, b]) await p.waitForSelector("#hud:not([hidden])");
  // a short countdown, then both play at once against a match clock
  expect(await a.textContent("#turn-label")).toMatch(/Starting in [1-3]/);
  for (const p of [a, b]) await p.waitForFunction(() => (window as any).__wriggle.snapshot()?.phase === "play", null, { timeout: 8000 });
  expect(await a.textContent("#timer")).toMatch(/^[23]:\d\d$/);
  await a.screenshot({ path: `${SHOTS}/game-p1.png` });
  await b.screenshot({ path: `${SHOTS}/game-p2.png` });

  // the joystick walks and jumps
  const stick = (await a.locator("#stick").boundingBox())!;
  const sc = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2 };
  const wormX = async () => { const s = await snap(a); return s.worms.find((w: any) => w.id === s.seats[0].active).x; };
  const wormY = async () => { const s = await snap(a); return s.worms.find((w: any) => w.id === s.seats[0].active).y; };
  const startX = await wormX();
  await a.mouse.move(sc.x, sc.y);
  await a.mouse.down();
  await a.mouse.move(sc.x + 40, sc.y, { steps: 3 });
  await a.waitForTimeout(700);
  await a.mouse.up();
  const walked = (await wormX()) - startX;
  expect(walked).not.toBe(0);
  const startY = await wormY();
  await a.mouse.move(sc.x, sc.y);
  await a.mouse.down();
  await a.mouse.move(sc.x, sc.y - 45, { steps: 2 });
  await a.waitForFunction((y0) => {
    const s = (window as any).__wriggle.snapshot();
    return s.worms.find((w: any) => w.id === s.seats[0].active).y < y0 - 8;
  }, startY, { timeout: 2000 });
  await a.mouse.up();
  await a.waitForTimeout(1200);

  // both players aim by dragging and fire in the same moment
  const firstA = (await snap(a)).seats[0].active;
  const firstB = (await snap(b)).seats[1].active;
  for (const [p, dx] of [[a, 120], [b, -120]] as const) {
    const me = await p.evaluate(() => (window as any).__wriggle.activeScreen());
    await p.mouse.move(me.x, me.y);
    await p.mouse.down();
    await p.mouse.move(me.x + dx, me.y - 110, { steps: 4 });
    await p.mouse.up();
  }
  // the Fire button wears the weapon it will fire
  expect(await a.getAttribute("#fire", "data-weapon")).toBe("rocket");
  expect(await a.locator("#fire svg").count()).toBe(1);

  // hold Fire to build speed, release to shoot: both players at once
  const fireAt = async (p: Page) => {
    const box = (await p.locator("#fire").boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const [fa, fb] = [await fireAt(a), await fireAt(b)];
  await a.mouse.move(fa.x, fa.y);
  await b.mouse.move(fb.x, fb.y);
  const heldFrom = Date.now();
  await Promise.all([a.mouse.down(), b.mouse.down()]);
  await a.waitForTimeout(650);
  const charging = await a.locator("#fire").evaluate((e) => ({ on: e.classList.contains("charging"), c: Number(getComputedStyle(e).getPropertyValue("--charge")) }));
  expect(charging.on).toBe(true);
  expect(charging.c).toBeGreaterThan(0.3);
  expect(charging.c).toBeLessThan(0.9);
  await a.screenshot({ path: `${SHOTS}/fire-charging.png` });
  await Promise.all([a.mouse.up(), b.mouse.up()]);
  const heldMs = Date.now() - heldFrom;
  // power tracks how long Fire was held (the screenshot above lengthens the hold on a busy machine)
  const pa = await a.evaluate(() => (window as any).__wriggle.lastFirePower());
  expect(pa).toBeGreaterThan(650 / 1300 - 0.05);
  expect(pa).toBeLessThanOrEqual(Math.min(1, heldMs / 1300 + 0.05));
  // both fired in the same moment: both weapons are reloading together (a shot may burst on a nearby
  // overhang at once on some maps, so shots in the air together is not a reliable signal)
  await a.waitForFunction(() => {
    const s = (window as any).__wriggle.snapshot();
    return s.seats[0].reload > 0 && s.seats[1].reload > 0;
  }, null, { timeout: 3000 });
  await a.screenshot({ path: `${SHOTS}/game-both-fired.png` });

  // each shooter keeps the same worm, and the Fire button shows the reload
  const s1 = await snap(a);
  expect(s1.seats[0].active).toBe(firstA);
  expect(s1.seats[1].active).toBe(firstB);
  expect(await a.locator("#fire").evaluate((e) => e.classList.contains("reloading"))).toBe(true);
  await a.waitForFunction(() => !document.querySelector("#fire")!.classList.contains("reloading"), null, { timeout: 5000 });

  // holding all the way fires by itself at full power
  await a.mouse.move(fa.x, fa.y);
  await a.mouse.down();
  await a.waitForFunction(() => (window as any).__wriggle.snapshot().seats[0].reload > 0, null, { timeout: 4000 });
  await a.mouse.up();
  expect(await a.evaluate(() => (window as any).__wriggle.lastFirePower())).toBe(1);

  // tapping another of my worms takes control of it
  const pick = await a.evaluate(() => {
    const w = (window as any).__wriggle;
    const s = w.snapshot();
    const other = s.worms.find((x: any) => x.team === 0 && x.alive && x.id !== s.seats[0].active);
    return { id: other.id, at: w.wormScreen(other.id) };
  });
  await a.evaluate((id) => (window as any).__wriggle.lookAt(id), pick.id);
  await a.waitForTimeout(400);
  const at = await a.evaluate((id) => (window as any).__wriggle.wormScreen(id), pick.id);
  await a.mouse.click(at.x, at.y);
  await a.waitForFunction((id) => (window as any).__wriggle.snapshot().seats[0].active === id, pick.id, { timeout: 3000 });

  // the weapon tray works at any moment
  await b.tap("#weapon");
  await b.waitForSelector("#tray:not([hidden])");
  await b.screenshot({ path: `${SHOTS}/tray.png` });
  await b.tap('[data-weapon="grenade"]');
  await b.waitForFunction(() => (window as any).__wriggle.snapshot().seats[1].weapon === "grenade");

  // a dropped player sees the match pause and resumes on reconnect
  await b.evaluate(() => (window as any).__wriggle.dropConnection());
  await a.waitForFunction(() => !document.querySelector("#paused")?.hasAttribute("hidden"));
  await b.waitForFunction(() => (window as any).__wriggle.connected() && document.querySelector("#paused")?.hasAttribute("hidden"), null, { timeout: 10000 });
  await a.waitForFunction(() => document.querySelector("#paused")?.hasAttribute("hidden"));

  expect(errors).toEqual([]);
  await a.context().close();
  await b.context().close();
}, 60000);

async function startMatch(hud: string): Promise<[Page, Page]> {
  const a = await open(phone, `/?hud=${hud}`);
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();
  const b = await open(phone, `/?room=${code}&hud=${hud}`);
  await b.fill("#name", "Bo");
  await b.tap("#join-cta");
  await b.waitForSelector("#lobby:not([hidden])");
  await a.waitForFunction(() => document.querySelector('[data-seat="1"] .seat-name')?.textContent === "Bo");
  await a.tap("#ready");
  await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.classList.contains("is-ready"));
  await b.tap("#ready");
  for (const p of [a, b]) await p.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 6);
  return [a, b];
}

test("the HUD makes clear who is winning", async () => {
  for (const hud of ["board"]) {
    const [a, b] = await startMatch(hud);
    expect(await a.textContent("#lead")).toBe("Dead even");
    expect(await a.textContent('.row[data-team="0"] .team-total')).toBe("300");
    expect(await a.locator('.row[data-team="1"] .pip.alive').count()).toBe(3);

    // Bo's team takes 170 damage: one worm at 30, one drowned
    const s = await snap(a);
    const theirs = s.worms.filter((w: any) => w.team === 1);
    theirs[0].hp = 30;
    theirs[1].hp = 0;
    theirs[1].alive = false;
    for (const p of [a, b]) await p.evaluate((x) => (window as any).__wriggle.preview(x), s);

    expect(await a.textContent("#lead")).toBe("You lead by 170");
    expect(await b.textContent("#lead")).toBe("Ada leads by 170");
    expect(await a.textContent('.row[data-team="1"] .team-total')).toBe("130");
    expect(await a.locator('.row[data-team="1"] .pip.alive').count()).toBe(2);
    expect(await a.locator('.row[data-team="0"]').evaluate((e) => e.classList.contains("leading"))).toBe(true);
    expect(await a.locator('.row[data-team="1"]').evaluate((e) => e.classList.contains("leading"))).toBe(false);
    // the leader is ranked first on the board
    expect(await a.locator('.row[data-team="0"]').evaluate((e) => getComputedStyle(e).order)).toBe("0");
    {
      // the shared bar animates; wait for it to settle on Ada's share (300 of 430)
      await a.waitForFunction(() => {
        const bar = document.querySelector("#tug")!.getBoundingClientRect();
        const left = document.querySelector('#tug .seg[data-team="0"]')!.getBoundingClientRect();
        const share = left.width / bar.width;
        return share > 0.66 && share < 0.73;
      }, null, { timeout: 3000 });
    }
    await a.waitForTimeout(700);
    await a.screenshot({ path: `${SHOTS}/lead-${hud}-p1.png` });
    await b.screenshot({ path: `${SHOTS}/lead-${hud}-p2.png` });
    expect(errors).toEqual([]);
    await a.context().close();
    await b.context().close();
  }
}, 90000);

test("each player chooses a colour in the lobby and it carries into the match", async () => {
  const a = await open();
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();
  const b = await open(phone, `/?room=${code}`);
  await b.fill("#name", "Bo");
  await b.tap("#join-cta");
  await a.waitForFunction(() => document.querySelector('[data-seat="1"] .seat-name')?.textContent === "Bo");

  // a palette on your own seat only, with the opponent's colour unavailable
  expect(await a.locator("#my-colors .swatch").count()).toBe(6);
  expect(await a.locator('#my-colors .swatch[data-color="teal"]').isDisabled()).toBe(true);
  for (const box of await a.locator("#my-colors .swatch").all()) expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(30);

  await a.tap('#my-colors .swatch[data-color="lime"]');
  await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.getAttribute("data-color") === "lime");
  expect(await b.locator('#my-colors .swatch[data-color="lime"]').isDisabled()).toBe(true);
  await b.tap('#my-colors .swatch[data-color="rose"]');
  await a.waitForFunction(() => document.querySelector('[data-seat="1"]')?.getAttribute("data-color") === "rose");
  await a.waitForTimeout(300);
  await a.screenshot({ path: `${SHOTS}/lobby-colors.png` });

  await a.tap("#ready");
  await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.classList.contains("is-ready"));
  await b.tap("#ready");
  for (const p of [a, b]) await p.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 6);

  // the HUD and the worms' headbands use the chosen colours on both phones
  for (const p of [a, b]) {
    expect(await p.evaluate(() => getComputedStyle(document.querySelector('.row[data-team="0"] .team-name')!).color)).toBe("rgb(155, 216, 78)");
    expect(await p.evaluate(() => getComputedStyle(document.querySelector('.row[data-team="1"] .team-name')!).color)).toBe("rgb(255, 92, 154)");
    expect(await p.evaluate(() => (window as any).__wriggle.teamColors().slice(0, 2))).toEqual(["#9bd84e", "#ff5c9a"]);
  }
  await a.waitForTimeout(600);
  await a.screenshot({ path: `${SHOTS}/game-colors.png` });
  expect(errors).toEqual([]);
  await a.context().close();
  await b.context().close();
}, 60000);

test("inviting is one tap: the link is visible, copyable, and the foundation is credited", async () => {
  const home = await open();
  const credit = home.locator("#credit a");
  expect(await credit.getAttribute("href")).toBe("https://manteiga.org");
  expect(await credit.textContent()).toContain("Manteiga Foundation");
  await home.context().close();

  const ctx = await browser.newContext({ ...phone, permissions: ["clipboard-read", "clipboard-write"] });
  const a = await ctx.newPage();
  a.on("pageerror", (e) => errors.push(String(e)));
  await a.goto(url + "/");
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();
  const link = (await a.textContent("#invite-link"))!.trim();
  expect(link.endsWith(`/?room=${code}`)).toBe(true);
  await a.evaluate(() => Object.defineProperty(navigator, "share", { value: undefined, configurable: true }));
  await a.tap("#copy-link");
  await a.waitForFunction(() => document.querySelector("#copy-link")?.textContent === "Copied");
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(`${url}/?room=${code}`);
  await a.screenshot({ path: `${SHOTS}/lobby-invite.png` });
  expect(errors).toEqual([]);
  await ctx.close();
}, 30000);

test("an invite link leads with Join, not Create", async () => {
  const a = await open();
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();

  const b = await open(phone, `/?room=${code}`);
  const cta = b.locator("#join-cta");
  expect(await cta.isVisible()).toBe(true);
  expect((await cta.textContent())!.trim()).toBe(`Join match ${code}`);
  expect(await cta.evaluate((e) => e.classList.contains("primary"))).toBe(true);
  expect(await b.locator("#create").isVisible()).toBe(false);
  expect(await b.textContent("#home-eyebrow")).toBe("Ada invites you");
  expect(await b.locator("#create-instead").isVisible()).toBe(true);
  await b.screenshot({ path: `${SHOTS}/home-invited.png` });

  // pressing Enter in the name field joins too
  await b.fill("#name", "Bo");
  await b.press("#name", "Enter");
  await b.waitForSelector("#lobby:not([hidden])");
  expect(await b.textContent("#room-code")).toBe(code);
  await a.waitForFunction(() => document.querySelector('[data-seat="1"] .seat-name')?.textContent === "Bo");
  await a.context().close();
  await b.context().close();

  // choosing to start a new match instead restores the normal home
  const c = await open(phone, `/?room=${code}`);
  await c.tap("#create-instead");
  expect(await c.locator("#create").isVisible()).toBe(true);
  expect(await c.locator("#join-cta").isVisible()).toBe(false);
  expect(new URL(c.url()).search).toBe("");
  await c.context().close();
  expect(errors).toEqual([]);
}, 40000);

test("phone controls never overlap, in either orientation", async () => {
  for (const [w, h] of [[390, 844], [360, 740], [375, 667], [844, 390], [667, 375], [740, 360]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await p.goto(url + "/");
    const r = await p.evaluate(() => {
      document.querySelector("#home")!.setAttribute("hidden", "");
      document.querySelector("#hud")!.removeAttribute("hidden");
      const boxes = ["stick", "weapon", "fire"].map((id) => document.getElementById(id)!.getBoundingClientRect());
      const hit = (a: DOMRect, c: DOMRect) => a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
      return {
        overlaps: [hit(boxes[0], boxes[1]), hit(boxes[0], boxes[2]), hit(boxes[1], boxes[2])].filter(Boolean).length,
        inside: boxes.every((b) => b.width > 0 && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight),
        legacy: ["move-left", "move-right", "jump"].filter((id) => document.getElementById(id)).length,
        stick: boxes[0].width,
      };
    });
    expect({ size: `${w}x${h}`, ...r }).toEqual({ size: `${w}x${h}`, overlaps: 0, inside: true, legacy: 0, stick: r.stick });
    expect(r.stick).toBeGreaterThanOrEqual(96);
    await ctx.close();
  }
}, 60000);

test("three phones play one match: three teams, three colours, one board", async () => {
  const a = await open();
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();
  const others: Page[] = [];
  for (const n of ["Bo", "Cy"]) {
    const p = await open(phone, `/?room=${code}`);
    await p.fill("#name", n);
    await p.tap("#join-cta");
    await p.waitForSelector("#lobby:not([hidden])");
    others.push(p);
  }
  const [b, c] = others;
  await a.waitForFunction(() => document.querySelectorAll("#seats .seat:not(.open)").length === 3);
  expect(await a.textContent('[data-seat="2"] .seat-title')).toBe("Ready Player Three");
  expect(await a.locator("#seats .seat.open").count()).toBe(1);
  // everything in the lobby fits a short landscape phone: Leave is on screen
  const leave = (await a.locator("#leave").boundingBox())!;
  expect(leave.y + leave.height).toBeLessThanOrEqual(390);
  await a.screenshot({ path: `${SHOTS}/lobby-three.png` });
  for (const p of [a, b]) await p.tap("#ready");
  await a.waitForTimeout(300);
  expect(await a.evaluate(() => (window as any).__wriggle.snapshot())).toBeNull();
  await c.tap("#ready");
  for (const p of [a, b, c]) await p.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 9);
  expect(await c.evaluate(() => (window as any).__wriggle.seat())).toBe(2);
  expect(await a.locator("#board .row").count()).toBe(3);
  expect(await a.locator("#tug .seg").count()).toBe(3);
  const colors = await a.evaluate(() => (window as any).__wriggle.teamColors().slice(0, 3));
  expect(new Set(colors).size).toBe(3);
  await a.waitForTimeout(3500);
  await a.screenshot({ path: `${SHOTS}/game-three.png` });
  expect(errors).toEqual([]);
  for (const p of [a, b, c]) await p.context().close();
}, 60000);
