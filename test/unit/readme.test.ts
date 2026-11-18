import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

// The public README's contract: an executive summary first (what it is, for whom, in a few
// sentences), then the game at work, and only then the technical sections. Every image it shows is
// in the repository and light enough for GitHub to serve.

const root = join(import.meta.dir, "../..");
const readme = await Bun.file(join(root, "README.md")).text();
const lines = readme.split("\n");

const headingLines = lines.map((l, i) => (/^#{1,3} /.test(l) ? i : -1)).filter((i) => i >= 0);
const imagePattern = /!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src="([^"]+)"/g;
const images = [...readme.matchAll(imagePattern)].map((m) => ({ src: m[1] ?? m[2], line: readme.slice(0, m.index).split("\n").length - 1 }));
const localImages = images.filter((i) => !/^https?:/.test(i.src));

describe("the public README", () => {
  test("opens with the title and an executive summary of two to six sentences before any other heading", () => {
    expect(headingLines[0]).toBe(0);
    expect(lines[0]).toMatch(/^# /);
    const secondHeading = headingLines[1];
    expect(secondHeading).toBeGreaterThan(1);
    const summary = lines
      .slice(1, secondHeading)
      .filter((l) => l.trim() && !/^!\[|^<img|^\[!\[|^<p|^<\/p|^<a|^<\/a/.test(l.trim()))
      .join(" ")
      .trim();
    const sentences = summary.split(/(?<=[.!?])\s+/).filter(Boolean);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(6);
    expect(summary.length).toBeLessThan(900);
    expect(summary).not.toMatch(/```|bun |npm |\$ /);
  });

  test("shows the game at work (a GIF) right after the summary, before the technical sections", () => {
    const secondHeading = headingLines[1];
    const early = images.filter((i) => i.line < secondHeading + 6);
    expect(early.length).toBeGreaterThanOrEqual(1);
    expect(early[0].src.endsWith(".gif")).toBe(true);
    const firstCode = lines.findIndex((l) => l.startsWith("```"));
    expect(early[0].line).toBeLessThan(firstCode === -1 ? Infinity : firstCode);
  });

  test("every image it shows is in the repository; the GIF under 5 MB, stills under 2 MB", () => {
    expect(localImages.length).toBeGreaterThanOrEqual(2);
    for (const { src } of localImages) {
      const file = join(root, src);
      expect(existsSync(file), src).toBe(true);
      const limit = src.endsWith(".gif") ? 5e6 : 2e6;
      expect(statSync(file).size, src).toBeLessThan(limit);
    }
  });

  test("every image has alternative text", () => {
    for (const tag of readme.match(/<img[^>]*>/g) ?? []) expect(tag, tag).toMatch(/alt="[^"]+"/);
  });

  test("the summary links to the live game, and Play comes before Install", () => {
    const summaryEnd = headingLines[1];
    expect(lines.slice(0, summaryEnd + 8).join("\n")).toContain("https://gusanito.manteiga.org");
    const play = lines.findIndex((l) => /^## Play/.test(l));
    const install = lines.findIndex((l) => /^## Install/.test(l));
    expect(play).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(play);
  });

  test("Install leads with the one-command installer in its own code block", () => {
    const install = lines.findIndex((l) => /^## Install/.test(l));
    const firstBlock = lines.findIndex((l, i) => i > install && l.startsWith("```"));
    expect(lines[firstBlock + 1]).toBe("curl -fsSL https://gusanito.manteiga.org/install.sh | sh");
  });

  test("badges are dynamic or durable: no counts that go stale", () => {
    const badges = images.filter((i) => i.src.includes("img.shields.io"));
    expect(badges.length).toBeGreaterThanOrEqual(4);
    expect(badges.some((b) => b.src.includes("/github/actions/workflow/status/"))).toBe(true);
    expect(badges.some((b) => b.src.includes("/github/v/release/"))).toBe(true);
    expect(readme).not.toMatch(/\d+ tests? pass/i);
  });

  test("carries no emoji and no first-person marketing voice", () => {
    expect(readme).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(readme).not.toMatch(/\b(we're|I'm|awesome|blazing|supercharge|ultimate)\b/i);
  });
});
