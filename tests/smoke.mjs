// Headless smoke test — serves the folder, plays the game, and checks the
// puzzle bank is internally consistent.
// Run: npm test   (needs `npx playwright install chromium` once).
import { chromium } from "playwright";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../", import.meta.url).pathname);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    // Don't serve anything outside the project folder.
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const cellText = (page) => page.$$eval("#grid .cell", (els) => els.map((e) => e.textContent));
const givenCount = (page) => page.$$eval("#grid .cell.given", (e) => e.length);
const freeTiles = (page) => page.$$eval("#tray .tile:not(.spent)", (e) => e.length);
const litPips = (page) => page.$$eval(".pip.on", (e) => e.length);

async function run() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const exe = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(base);
  await page.waitForSelector("#grid .cell");

  // 1) The bank itself: every stored square really is a double word square.
  const bankCheck = await page.evaluate(() => {
    const d = window.WORD_SQUARE_DATA;
    const report = { counts: {}, problems: [] };
    for (const n of [4, 5]) {
      const dict = new Set(d.WORDS[n]);
      for (const mode of ["easy", "hard"]) {
        const seen = new Set();
        for (const flat of d.BANK[n][mode]) {
          const where = `${n}x${n} ${mode}`;
          if (flat.length !== n * n) { report.problems.push(`${where}: bad length "${flat}"`); continue; }
          if (seen.has(flat)) report.problems.push(`${where}: duplicate "${flat}"`);
          seen.add(flat);

          const rows = [], cols = [];
          for (let k = 0; k < n; k++) {
            let row = "", col = "";
            for (let j = 0; j < n; j++) { row += flat[k * n + j]; col += flat[j * n + k]; }
            rows.push(row); cols.push(col);
            if (!dict.has(row)) report.problems.push(`${where}: row "${row}" not a word`);
            if (!dict.has(col)) report.problems.push(`${where}: col "${col}" not a word`);
          }
          // The difficulty IS the shape, so check it rather than trust it.
          const mirrored = rows.every((r, k) => r === cols[k]);
          const shares = rows.some((r) => cols.includes(r));
          if (mode === "easy" && !mirrored) report.problems.push(`easy but not mirrored: "${flat}"`);
          if (mode === "hard" && shares) report.problems.push(`hard but a row repeats a column: "${flat}"`);
        }
        report.counts[`${n}${mode}`] = d.BANK[n][mode].length;
      }
    }
    return report;
  });
  assert(bankCheck.problems.length === 0, "bank problems: " + bankCheck.problems.slice(0, 5).join(" | "));

  // Words that are also somebody's name are still words. A first-names filter
  // once threw hundreds of them out of the dictionary, so a player who wrote
  // WILL across a row was told it wasn't a word. Pinned in both directions.
  const naming = await page.evaluate(() => {
    const d = window.WORD_SQUARE_DATA;
    const four = new Set(d.WORDS[4]), five = new Set(d.WORDS[5]);
    return {
      missing: [...["will", "bill", "mark", "rose", "hope", "dawn", "jack", "gene"].filter((w) => !four.has(w)),
        ...["grace", "faith", "chase", "brook", "olive", "pearl", "robin", "amber"].filter((w) => !five.has(w))],
      // Actual proper nouns: the Scrabble dictionary keeps these out by itself.
      present: [...["dave", "erik"].filter((w) => four.has(w)),
        ...["helen", "santa", "jesus"].filter((w) => five.has(w))]
    };
  });
  assert(naming.missing.length === 0,
    `words that are also names must count: missing ${naming.missing.join(" ")}`);
  assert(naming.present.length === 0,
    `proper nouns must not: found ${naming.present.join(" ")}`);

  // A row is checked against the whole Scrabble dictionary, not the much
  // smaller pool the squares are built from. The two are different questions:
  // a bank built over the whole list would deal grids spelling QOPH and XYST.
  const breadth = await page.evaluate(() => {
    const d = window.WORD_SQUARE_DATA;
    const four = new Set(d.WORDS[4]), five = new Set(d.WORDS[5]);
    return {
      counts: [d.WORDS[4].length, d.WORDS[5].length],
      missing: [...["deet", "qoph", "zarf", "xyst", "fyce"].filter((w) => !four.has(w)),
        ...["zayin", "qophs", "xylyl"].filter((w) => !five.has(w))],
      // The hand-written exclusions still hold against the wider list.
      slipped: [...["nazi"].filter((w) => four.has(w)),
        ...["texas", "turks", "hogan", "moore"].filter((w) => five.has(w))]
    };
  });
  assert(breadth.counts[0] > 3500 && breadth.counts[1] > 8000,
    `the whole Scrabble list is accepted, got ${breadth.counts.join(" and ")}`);
  assert(breadth.missing.length === 0,
    `Scrabble words must count: missing ${breadth.missing.join(" ")}`);
  assert(breadth.slipped.length === 0,
    `the curated exclusions still hold: found ${breadth.slipped.join(" ")}`);
  assert(Object.values(bankCheck.counts).every((c) => c >= 50),
    `a bank is too small: ${JSON.stringify(bankCheck.counts)}`);

  // 2) Every icon the page declares is actually there. A missing one sends the
  //    browser hunting for a fallback, which on a shared github.io address
  //    means picking up a neighbouring app's icon.
  const icons = await page.$$eval("link[rel~='icon'], link[rel='apple-touch-icon']",
    (els) => els.map((e) => e.getAttribute("href")));
  assert(icons.length >= 7, `expected the full icon set, got ${icons.length}`);
  for (const href of icons) {
    const res = await page.request.get(new URL(href, base).href);
    assert(res.status() === 200, `icon ${href} -> HTTP ${res.status()}`);
    assert((await res.body()).length > 0, `icon ${href} is empty`);
  }

  // 3) Help shows on a first visit, and closes.
  assert(await page.$eval("#helpBack", (e) => !e.classList.contains("hidden")), "help opens first time");
  await page.click("#helpClose");
  assert(await page.$eval("#helpBack", (e) => e.classList.contains("hidden")), "help closes");

  // 4) A fresh 4x4 board: 16 squares, 6 givens, 10 letters in the tray, and
  //    every row and column carries at least one given.
  assert(await page.$eval("#modeEasy", (e) => e.classList.contains("active")), "opens on Easy");
  assert((await cellText(page)).length === 16, "16 cells");
  assert((await givenCount(page)) === 6, `6 givens, got ${await givenCount(page)}`);
  assert((await freeTiles(page)) === 10, `10 tray tiles, got ${await freeTiles(page)}`);
  const cover = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#grid .cell")];
    const rows = new Set(), cols = new Set();
    cells.forEach((el, i) => {
      if (el.classList.contains("given")) { rows.add(Math.floor(i / 4)); cols.add(i % 4); }
    });
    return { rows: rows.size, cols: cols.size };
  });
  assert(cover.rows === 4 && cover.cols === 4, `givens cover every line, got ${JSON.stringify(cover)}`);

  // 5) Placing and taking back a letter, via the tray.
  const before = await freeTiles(page);
  await page.click("#tray .tile:not(.spent)");
  assert((await freeTiles(page)) === before - 1, "tray tile is spent after placing");
  const placedAt = await page.evaluate(() =>
    [...document.querySelectorAll("#grid .cell")].findIndex(
      (e) => e.textContent && !e.classList.contains("given")));
  assert(placedAt >= 0, "a letter landed on the board");
  await page.click(`#grid .cell:nth-child(${placedAt + 1})`);
  assert((await freeTiles(page)) === before, "tapping a placed letter returns it");

  // 6) A hint fills a square and counts.
  await page.click("#hintBtn");
  assert((await freeTiles(page)) === before - 1, "hint consumes a tray letter");
  assert((await page.evaluate(() => window.game._debug.state().hints)) === 1, "hint counted");

  // 7) Solving lights every pip and opens the win dialog.
  await page.evaluate(() => window.game._debug.solve());
  assert((await litPips(page)) === 8, `8 pips lit on a solved 4x4, got ${await litPips(page)}`);
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  assert(/^\d+:\d\d$/.test(await page.$eval("#winTime", (e) => e.textContent)), "win time shown");
  // A symmetric square reads the same down as across, so the list is deduped:
  // somewhere between n (fully symmetric) and 2n (all distinct) words.
  const listed = await page.$$eval("#winWords span", (e) => e.map((x) => x.textContent));
  assert(listed.length >= 4 && listed.length <= 8, `4-8 words listed, got ${listed.length}`);
  assert(new Set(listed).size === listed.length, "word list has no duplicates");
  assert(listed.every((w) => w.length === 4), "listed words are 4 letters");
  assert((await page.$eval("#winStreak", (e) => e.textContent)) === "1", "daily solve starts a streak");
  await page.click("#winBack", { position: { x: 5, y: 5 } });

  // 8) The 5x5 board.
  await page.click("#size5");
  assert((await cellText(page)).length === 25, "25 cells at 5x5");
  assert((await givenCount(page)) === 9, `9 givens at 5x5, got ${await givenCount(page)}`);
  assert((await freeTiles(page)) === 16, `16 tray tiles at 5x5, got ${await freeTiles(page)}`);

  // 9) Typing works, and a letter the tray doesn't hold is refused.
  await page.click("#grid .cell:not(.given)");
  const spare = await page.evaluate(() => {
    const have = new Set([...document.querySelectorAll("#tray .tile:not(.spent)")].map((e) => e.textContent));
    return "abcdefghijklmnopqrstuvwxyz".split("").find((c) => !have.has(c));
  });
  const tilesBefore = await freeTiles(page);
  await page.keyboard.press(spare);
  assert((await freeTiles(page)) === tilesBefore, "a letter not in the tray is refused");
  assert(await page.$eval("#toast", (e) => e.classList.contains("show")), "refusal is explained");
  const inTray = await page.$eval("#tray .tile:not(.spent)", (e) => e.textContent);
  await page.keyboard.press(inTray);
  assert((await freeTiles(page)) === tilesBefore - 1, "typing a tray letter places it");

  // 10) Difficulty switches the puzzle and survives a reload.
  const easyId = await page.evaluate(() => window.game._debug.state().id);
  await page.click("#modeHard");
  const hardState = await page.evaluate(() => window.game._debug.state());
  assert(hardState.mode === "hard", "switched to hard");
  assert(hardState.id.includes(":hard:"), `hard puzzle id, got ${hardState.id}`);
  assert(hardState.id !== easyId, "hard is a different puzzle from easy");
  const hardSolved = await page.evaluate(() => {
    // The whole point of hard: no row may repeat a column.
    const n = window.game._debug.state().n;
    const d = window.WORD_SQUARE_DATA;
    return d.BANK[n].hard.every((flat) => {
      const rows = [], cols = [];
      for (let k = 0; k < n; k++) {
        let r = "", c = "";
        for (let j = 0; j < n; j++) { r += flat[k * n + j]; c += flat[j * n + k]; }
        rows.push(r); cols.push(c);
      }
      return !rows.some((r) => cols.includes(r));
    });
  });
  assert(hardSolved, "every hard puzzle at this size is mirror-free");
  await page.click("#modeEasy");

  // 11) The date label carries the date and nothing else.
  const label = await page.$eval("#puzLabel", (e) => e.textContent);
  assert(/^Daily · \d{4}-\d\d-\d\d$/.test(label), `bare date label, got "${label}"`);

  // 12) Progress survives a reload, and the daily puzzle is the same puzzle.
  const midway = await page.evaluate(() => window.game._debug.state());
  await page.reload();
  await page.waitForSelector("#grid .cell");
  const after = await page.evaluate(() => window.game._debug.state());
  assert(after.id === midway.id, `same daily puzzle after reload: ${midway.id} vs ${after.id}`);
  assert(after.cells === midway.cells, "grid restored after reload");
  assert(after.n === 5, "size remembered after reload");

  // 13) Random practice puzzles load and differ from the daily one.
  await page.click("#newBtn");
  const rnd = await page.evaluate(() => window.game._debug.state());
  assert(rnd.id.startsWith("free:5:easy:"), `random puzzle loaded, got ${rnd.id}`);
  await page.evaluate(() => window.game._debug.solve());
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  assert((await litPips(page)) === 10, "10 pips lit on a solved 5x5");
  await page.click("#winBack", { position: { x: 5, y: 5 } });

  // 14) The label leads back to today's puzzle.
  await page.click("#puzLabel .link");
  const home = await page.evaluate(() => window.game._debug.state());
  assert(home.id.startsWith("daily:5:easy:"), `back on the daily puzzle, got ${home.id}`);

  assert(errors.length === 0, "page errors: " + errors.join(" | "));
  await browser.close();
  server.close();
  console.log(`PASS — banks ${JSON.stringify(bankCheck.counts)} verified, play/hint/solve/difficulty/reload OK`);
}

run().catch((err) => { console.error("FAIL —", err.message); process.exit(1); });
