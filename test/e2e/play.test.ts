import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, devices, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { startServer } from "../../src/server/server.ts";

const SHOTS = process.env.SHOTS_DIR ?? "test-results";
mkdirSync(SHOTS, { recursive: true });

let server: ReturnType<typeof startServer>;
let browser: Browser;
let url = "";
const errors: string[] = [];

// A phone held in landscape: the layout the game is designed for.
const phone = { ...devices["iPhone 13"], viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true };
const portrait = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

beforeAll(async () => {
  server = startServer({ port: 0, staticDir: "dist", hostname: "127.0.0.1" });
  url = `http://127.0.0.1:${server.port}`;
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
