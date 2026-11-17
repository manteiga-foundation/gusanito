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
  browser = await chromium.launch();
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
  await p.screenshot({ path: `${SHOTS}/home-landscape.png` });
  await p.context().close();
  const q = await open(portrait);
  await q.screenshot({ path: `${SHOTS}/home-portrait.png` });
  await q.context().close();
});

test("two phones meet in the Ready Player One / Two lobby and play a turn", async () => {
  const a = await open();
  await a.fill("#name", "Ada");
  await a.tap("#create");
  await a.waitForSelector("#lobby:not([hidden])");
  const code = (await a.textContent("#room-code"))!.trim();
  expect(code).toMatch(/^[A-Z]{4}$/);

  const b = await open(phone, `/?room=${code}`);
  await b.fill("#name", "Bo");
  await b.tap("#join");
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
  await a.waitForTimeout(600);
  await a.screenshot({ path: `${SHOTS}/game-p1.png` });
  await b.screenshot({ path: `${SHOTS}/game-p2.png` });
  expect((await snap(a)).team).toBe(0);
  expect(await a.textContent("#turn-label")).toContain("Your turn");
  expect(await b.textContent("#turn-label")).toContain("Ada");

  // aim by dragging on the canvas, then fire
  const me = await a.evaluate(() => (window as any).__wriggle.activeScreen());
  await a.mouse.move(me.x, me.y);
  await a.mouse.down();
  await a.mouse.move(me.x + 120, me.y - 90, { steps: 4 });
  await a.mouse.up();
  await a.waitForTimeout(150);
  const aim = (await snap(b)).aim;
  expect(aim).toBeLessThan(0);
  expect(aim).toBeGreaterThan(-Math.PI / 2);
  await a.tap("#fire");
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${SHOTS}/game-p1-fired.png` });
  await b.waitForFunction(() => (window as any).__wriggle.snapshot().team === 1, null, { timeout: 15000 });
  await b.waitForFunction(() => document.querySelector("#turn-label")?.textContent?.includes("Your turn"));
  await b.screenshot({ path: `${SHOTS}/game-p2-turn.png` });

  // the weapon tray switches weapons for the player on turn
  await b.tap("#weapon");
  await b.waitForSelector("#tray:not([hidden])");
  await b.screenshot({ path: `${SHOTS}/tray.png` });
  await b.tap('[data-weapon="grenade"]');
  await b.waitForFunction(() => (window as any).__wriggle.snapshot().weapon === "grenade");

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
  await b.tap("#join");
  await b.waitForSelector("#lobby:not([hidden])");
  await a.waitForFunction(() => document.querySelector('[data-seat="1"] .seat-name')?.textContent === "Bo");
  await a.tap("#ready");
  await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.classList.contains("is-ready"));
  await b.tap("#ready");
  for (const p of [a, b]) await p.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 6);
  return [a, b];
}

test("the HUD makes clear who is winning", async () => {
  for (const hud of ["bar", "cards"]) {
    const [a, b] = await startMatch(hud);
    expect(await a.textContent("#lead")).toBe("Dead even");
    expect(await a.textContent(".team.t0 .team-total")).toBe("300");
    expect(await a.locator(".team.t1 .pip.alive").count()).toBe(3);

    // Bo's team takes 170 damage: one worm at 30, one drowned
    const s = await snap(a);
    const theirs = s.worms.filter((w: any) => w.team === 1);
    theirs[0].hp = 30;
    theirs[1].hp = 0;
    theirs[1].alive = false;
    for (const p of [a, b]) await p.evaluate((x) => (window as any).__wriggle.preview(x), s);

    expect(await a.textContent("#lead")).toBe("You lead by 170");
    expect(await b.textContent("#lead")).toBe("Ada leads by 170");
    expect(await a.textContent(".team.t1 .team-total")).toBe("130");
    expect(await a.locator(".team.t1 .pip.alive").count()).toBe(2);
    expect(await a.locator(".team.t0").evaluate((e) => e.classList.contains("leading"))).toBe(true);
    expect(await a.locator(".team.t1").evaluate((e) => e.classList.contains("leading"))).toBe(false);
    if (hud === "bar") {
      // the fill animates; wait for it to settle on Ada's share (300 of 430)
      await a.waitForFunction(() => {
        const bar = document.querySelector("#tug")!.getBoundingClientRect();
        const left = document.querySelector("#tug .fill.t0")!.getBoundingClientRect();
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
  await b.tap("#join");
  await a.waitForFunction(() => document.querySelector('[data-seat="1"] .seat-name')?.textContent === "Bo");

  // a palette on your own seat only, with the opponent's colour unavailable
  expect(await a.locator('[data-seat="0"] .swatch').count()).toBe(6);
  expect(await a.locator('[data-seat="1"] .swatch').count()).toBe(0);
  expect(await a.locator('[data-seat="0"] .swatch[data-color="teal"]').isDisabled()).toBe(true);
  for (const box of await a.locator('[data-seat="0"] .swatch').all()) expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(30);

  await a.tap('[data-seat="0"] .swatch[data-color="lime"]');
  await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.getAttribute("data-color") === "lime");
  expect(await b.locator('[data-seat="1"] .swatch[data-color="lime"]').isDisabled()).toBe(true);
  await b.tap('[data-seat="1"] .swatch[data-color="rose"]');
  await a.waitForFunction(() => document.querySelector('[data-seat="1"]')?.getAttribute("data-color") === "rose");
  await a.waitForTimeout(300);
  await a.screenshot({ path: `${SHOTS}/lobby-colors.png` });

  await a.tap("#ready");
  await b.waitForFunction(() => document.querySelector('[data-seat="0"]')?.classList.contains("is-ready"));
  await b.tap("#ready");
  for (const p of [a, b]) await p.waitForFunction(() => (window as any).__wriggle.snapshot()?.worms?.length === 6);

  // the HUD and the worms' headbands use the chosen colours on both phones
  for (const p of [a, b]) {
    expect(await p.evaluate(() => getComputedStyle(document.querySelector(".team.t0 .team-name")!).color)).toBe("rgb(155, 216, 78)");
    expect(await p.evaluate(() => getComputedStyle(document.querySelector(".team.t1 .team-name")!).color)).toBe("rgb(255, 92, 154)");
    expect(await p.evaluate(() => (window as any).__wriggle.teamColors())).toEqual(["#9bd84e", "#ff5c9a"]);
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
