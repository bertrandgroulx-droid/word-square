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

  // Dates the way the page sees them, so the test agrees with the game about
  // which day it is even around midnight.
  const dates = await page.evaluate(() => {
    const d = window.game._debug.daily;
    const t = d.today();
    return {
      today: d.iso(t), yesterday: d.iso(d.addDays(t, -1)), before: d.iso(d.addDays(t, -2)), third: d.iso(d.addDays(t, -3)),
      number: d.dayOfYear(t)
    };
  });
  const state = () => page.evaluate(() => window.game._debug.state());
  const modalOpen = (id) => page.$eval(id, (e) => !e.classList.contains("hidden"));
  const query = () => new URL(page.url()).search;

  // 4) It opens straight into today's puzzle: 4x4 Easy, 16 squares, 6 givens,
  //    10 letters in the tray, every row and column carrying at least one
  //    given, the daily line under the controls, and a bare address.
  assert(await page.$eval("#modeEasy", (e) => e.classList.contains("active")), "opens on Easy");
  const opening = await state();
  assert(opening.id === `daily:4:easy:${dates.today}`, `today's daily, got ${opening.id}`);
  assert(query() === "", `today's puzzle has a bare address, got "${query()}"`);
  const label = await page.$eval("#puzLabel", (e) => e.textContent);
  assert(new RegExp(`^Daily No\\. ${dates.number} · \\w{3}, \\w{3} \\d{1,2}$`).test(label), `daily line, got "${label}"`);
  assert.deepStrictEqual(await page.$$eval("#dailyLinks a", (a) => a.map((x) => x.textContent)),
    ["Past puzzles", "Random puzzles"], "the daily's two links");
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
  assert((await state()).hints === 1, "hint counted");

  // 7) Progress survives a reload, and the daily puzzle is the same puzzle.
  const midway = await state();
  await page.reload();
  await page.waitForSelector("#grid .cell");
  const after = await state();
  assert(after.id === midway.id, `same daily puzzle after reload: ${midway.id} vs ${after.id}`);
  assert(after.cells === midway.cells, "grid restored after reload");
  assert(after.hints === 1, "hint count restored after reload");

  // 8) Solving lights every pip and opens the results, in the shared order:
  //    the score, a verdict, the streak (none yet), the saved line, then the
  //    game's own time, hints and words.
  await page.evaluate(() => window.game._debug.solve());
  assert((await litPips(page)) === 8, `8 pips lit on a solved 4x4, got ${await litPips(page)}`);
  // The finished grid stays on screen; the score waits behind its button.
  assert(!(await modalOpen("#winBack")), "solving does not cover the grid with the results");
  assert(await page.$eval("#scoreBtn", (b) => !b.classList.contains("hidden")), "a solved grid offers See your score");
  assert(await page.$eval("#hintBtn", (b) => b.classList.contains("hidden")), "the tools step aside once solved");
  await page.click("#scoreBtn");
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  const text = (id) => page.$eval(id, (e) => e.textContent.trim());
  // solve() clears the grid first, so the hinted square was placed by hand.
  assert((await text("#winScore")) === "10 / 10", `score out of the tray letters, got "${await text("#winScore")}"`);
  assert((await text("#winVerdict")) === "A perfect game.", "verdict");
  assert(await page.$eval("#winStreak", (e) => e.classList.contains("hidden")), "no streak line for one day");
  assert((await text("#winSaved")) === "Saved as your score for today.", "first score saved");
  assert(/^\d+:\d\d$/.test(await text("#winTime")), "win time shown");
  assert((await text("#winHints")) === "1", "hints asked for are reported");
  const order = await page.$$eval("#winBack .modal > *", (els) => els.map((e) => e.id || e.className));
  assert(order.indexOf("winScore") < order.indexOf("winVerdict") && order.indexOf("winVerdict") < order.indexOf("winStreak")
    && order.indexOf("winStreak") < order.indexOf("winSaved") && order.indexOf("winSaved") < order.indexOf("winStats"),
    `results order score, verdict, streak, saved, then the game's own: ${order.join(" ")}`);
  // A symmetric square reads the same down as across, so the list is deduped:
  // somewhere between n (fully symmetric) and 2n (all distinct) words.
  const listed = await page.$$eval("#winWords span", (e) => e.map((x) => x.textContent));
  assert(listed.length >= 4 && listed.length <= 8, `4-8 words listed, got ${listed.length}`);
  assert(new Set(listed).size === listed.length, "word list has no duplicates");
  assert(listed.every((w) => w.length === 4), "listed words are 4 letters");
  assert.deepStrictEqual(await page.$$eval("#winBack button:not(.hidden)", (b) => b.map((x) => x.textContent)),
    ["Play random puzzles", "Share", "Past puzzles", "See the grid", "Play it again"], "the ways on, in order");
  await page.click("#winGrid");
  assert(!(await modalOpen("#winBack")) && (await litPips(page)) === 8, "See the grid goes back to the finished square");
  await page.click("#scoreBtn");
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  const kept = await page.evaluate((iso) => JSON.parse(localStorage.getItem("wordsquare:daily:" + iso)), dates.today);
  assert(kept && kept.score === 10 && kept.max === 10 && kept.results.length === 10, `record kept in the kit's shape, got ${JSON.stringify(kept)}`);
  assert(kept.recap.words.length === listed.length && typeof kept.recap.time === "number", "recap holds the words and the time");
  const share = await page.evaluate(() => window.game._debug.shareText());
  assert(share.startsWith(`Word Square No. ${dates.number} · `) && share.includes("\n10/10") && (share.match(/🟦/g) || []).length === 6
    && (share.match(/\n[🟩🟦🟨]{4}/g) || []).length === 4, `share text carries the grid as squares, got ${JSON.stringify(share)}`);

  // 9) Played today: a reload opens straight on the results, and the saved
  //    line now says the first score is the one kept.
  await page.reload();
  await page.waitForSelector("#grid .cell");
  assert(!(await modalOpen("#winBack")) && (await litPips(page)) === 8, "a played day opens on its finished grid");
  await page.click("#scoreBtn");
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  assert((await text("#winSaved")) === "Your first score for this puzzle is the one that is kept.", "kept-score wording on a revisit");

  // 10) First score kept: play it again with a hint, and the record does not move.
  await page.click("#winAgain");
  assert(!(await modalOpen("#winBack")), "results close for a replay");
  assert((await freeTiles(page)) === 10, "the replay starts over");
  await page.click("#hintBtn");
  await page.evaluate(() => {
    // Solve by hand rather than with solve(), which clears the grid first:
    // the hinted square has to stay a hint for the score to show the cost.
    const d = window.game._debug;
    const p = d.dailyFor(d.state().iso);
    const have = d.state().cells.split("");
    const gridEls = document.querySelectorAll("#grid .cell");
    p.sol.split("").forEach((ch, i) => {
      if (have[i].trim()) return;
      gridEls[i].click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    });
  });
  await page.click("#scoreBtn");
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  assert((await text("#winScore")) === "9 / 10", `a hint costs its square, got "${await text("#winScore")}"`);
  assert((await text("#winSaved")) === "Your first score for this puzzle is the one that is kept.", "replay is not saved");
  const still = await page.evaluate((iso) => JSON.parse(localStorage.getItem("wordsquare:daily:" + iso)), dates.today);
  assert(still.score === 10 && still.at === kept.at, "the first score stays as it was");
  await page.click("#winBack", { position: { x: 5, y: 5 } });
  assert(!(await modalOpen("#winBack")), "tapping outside closes the results");

  // 11) Another size is a random puzzle, not another daily.
  await page.click("#size5");
  const five = await state();
  assert(five.id.startsWith("free:5:easy:"), `5x5 is a random puzzle, got ${five.id}`);
  assert(query() === "?practice", `random puzzles are at ?practice, got "${query()}"`);
  assert((await page.$eval("#puzLabel", (e) => e.textContent)).startsWith("Random puzzles"), "random line");
  assert.deepStrictEqual(await page.$$eval("#dailyLinks a", (a) => a.map((x) => x.textContent)),
    ["Today’s puzzle", "Past puzzles"], "a random puzzle's two links");
  assert((await cellText(page)).length === 25, "25 cells at 5x5");
  assert((await givenCount(page)) === 9, `9 givens at 5x5, got ${await givenCount(page)}`);
  assert((await freeTiles(page)) === 16, `16 tray tiles at 5x5, got ${await freeTiles(page)}`);

  // 12) Typing works, and a letter the tray doesn't hold is refused.
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

  // 13) Difficulty is a random-puzzle setting too, and it is remembered.
  await page.click("#modeHard");
  const hardState = await state();
  assert(hardState.mode === "hard", "switched to hard");
  assert(hardState.id.startsWith("free:5:hard:"), `hard random puzzle, got ${hardState.id}`);
  assert(hardState.id !== five.id, "hard is a different puzzle from easy");
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
  assert.deepStrictEqual(await page.evaluate(() => [localStorage.getItem("wordsquare:size"), localStorage.getItem("wordsquare:mode")]),
    ["5", '"hard"'], "the random-puzzle settings are remembered");

  // 14) A random puzzle's results: nothing saved, and a way back to today.
  await page.click("#newBtn");
  const rnd = await state();
  assert(rnd.id.startsWith("free:5:hard:"), `the dice deal another random puzzle, got ${rnd.id}`);
  await page.evaluate(() => window.game._debug.solve());
  await page.click("#scoreBtn");
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  assert((await litPips(page)) === 10, "10 pips lit on a solved 5x5");
  assert((await text("#winScore")) === "16 / 16", "5x5 is out of 16");
  assert((await text("#winSaved")) === "Random puzzle scores are not saved.", "random results are not saved");
  assert.deepStrictEqual(await page.$$eval("#winBack button:not(.hidden)", (b) => b.map((x) => x.textContent)),
    ["More random puzzles", "Share", "Past puzzles", "See the grid", "Today’s puzzle"], "a random puzzle's ways on");
  assert((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("wordsquare:daily:")).length)) === 1,
    "only today's record exists");

  // 15) Today's puzzle, from the results and from the daily line.
  await page.click("#winAgain");   // reads "Today's puzzle" on a random puzzle
  assert(!(await modalOpen("#winBack")) && (await state()).done, "today's is played, so it opens on its finished grid");
  assert((await state()).id === `daily:4:easy:${dates.today}`, "back on today's puzzle");
  assert(query() === "", "and the address is bare again");
  await page.click("#dailyLinks a[data-go=random]");
  assert((await state()).kind === "free", "Random puzzles link deals one");
  await page.click("#dailyLinks a[data-go=today]");
  assert((await state()).id === `daily:4:easy:${dates.today}`, "Today's puzzle link comes home");
  assert(!(await modalOpen("#winBack")) && (await state()).done, "and shows the finished grid, not the results");

  // 16) Past puzzles: the previous 100 days, newest first, today marked with
  //     its kept score, and a day opens when tapped.
  await page.click("#dailyLinks a[data-go=past]");
  assert(await modalOpen("#pastBack"), "past puzzles opens");
  assert(query() === "?past", `past puzzles is at ?past, got "${query()}"`);
  const rows = await page.$$eval("#pastList a", (a) => a.map((x) => ({
    iso: x.dataset.daily, today: x.classList.contains("today"),
    n: x.querySelector(".n").textContent, d: x.querySelector(".d").textContent, s: x.querySelector(".s").textContent
  })));
  assert(rows.length === 101, `today and the previous 100 days, got ${rows.length}`);
  assert(rows[0].iso === dates.today && rows[0].today && rows[0].n === `No. ${dates.number}` && rows[0].d.startsWith("Today, ") && rows[0].s === "10 / 10",
    `today's row, got ${JSON.stringify(rows[0])}`);
  assert(rows[1].iso === dates.yesterday && !rows[1].today && rows[1].s === "Not played", `yesterday's row, got ${JSON.stringify(rows[1])}`);
  await page.click(`#pastList a[data-daily="${dates.yesterday}"]`);
  assert(!(await modalOpen("#pastBack")) && !(await modalOpen("#winBack")), "an unplayed day opens as a puzzle");
  assert((await state()).id === `daily:4:easy:${dates.yesterday}`, "yesterday's puzzle loaded");
  assert(query() === `?daily=${dates.yesterday}`, `a past day is at ?daily=, got "${query()}"`);
  assert((await page.$eval("#puzLabel", (e) => e.textContent)).startsWith(`Daily No. ${dates.number - 1 || 365}`), "yesterday's number");
  await page.evaluate(() => window.game._debug.solve());
  await page.click("#scoreBtn");
  await page.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
  assert((await text("#winSaved")) === "Saved as your score for this day.", "a past day is saved for that day");
  assert(await page.$eval("#winStreak", (e) => e.classList.contains("hidden")), "no streak line on a past day");

  // 17) The daily draw: the same day gives the same grid every time, and the
  //     day after is a different one. The live puzzle matches the draw.
  const draw = await page.evaluate((d) => {
    const g = window.game._debug;
    return { a: g.dailyFor(d.today), b: g.dailyFor(d.today), y: g.dailyFor(d.yesterday), live: g.state() };
  }, dates);
  assert.deepStrictEqual(draw.a, draw.b, "same day, same puzzle");
  assert(draw.a.sol !== draw.y.sol, "adjacent days are different puzzles");
  assert(draw.y.id === draw.live.id, "the loaded puzzle is the day's draw");

  // 18) The address opens the right place.
  await page.goto(base + "?past");
  await page.waitForSelector("#pastList a");
  assert(await modalOpen("#pastBack"), "?past opens past puzzles");
  assert(await page.$eval(`#pastList a[data-daily="${dates.yesterday}"] .s`, (e) => e.textContent === "10 / 10"), "yesterday's kept score is listed");
  await page.goto(base + "?practice");
  await page.waitForSelector("#grid .cell");
  const prac = await state();
  assert(prac.id.startsWith("free:5:hard:"), `?practice deals a random puzzle at the remembered settings, got ${prac.id}`);
  await page.goto(base + "?daily=" + dates.before);
  await page.waitForSelector("#grid .cell");
  assert((await state()).id === `daily:4:easy:${dates.before}` && !(await modalOpen("#winBack")), "?daily= opens that day's puzzle");
  await page.goto(base + "?daily=2999-01-01");
  await page.waitForSelector("#pastList a");
  assert(await modalOpen("#pastBack"), "a day that has not happened yet shows the list instead");

  assert(errors.length === 0, "page errors: " + errors.join(" | "));
  await ctx.close();

  // 19) The streak: days in a row ending today or yesterday. Two kept days
  //     before today, then today's solve, make three.
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await p.waitForSelector("#grid .cell");
    await p.evaluate((d) => {
      const rec = { score: 8, max: 10, results: [1, 1, 1, 1, 0, 1, 1, 0, 1, 1], recap: { time: 60, hints: 2, words: ["able"], squares: "🟩" }, at: 1 };
      localStorage.setItem("wordsquare:daily:" + d.yesterday, JSON.stringify(rec));
      localStorage.setItem("wordsquare:daily:" + d.before, JSON.stringify(rec));
      localStorage.setItem("wordsquare:help-seen", "1");
    }, dates);
    await p.reload();
    await p.waitForSelector("#grid .cell");
    assert((await p.evaluate(() => window.game._debug.daily.streak())) === 2, "two days ending yesterday count");
    await p.evaluate(() => window.game._debug.solve());
    await p.click("#scoreBtn");
    await p.waitForSelector("#winBack:not(.hidden)", { timeout: 3000 });
    assert((await p.$eval("#winStreak", (e) => e.textContent)) === "3 days in a row", "today's solve makes three");
    assert(!(await p.$eval("#winStreak", (e) => e.classList.contains("hidden"))), "streak line shown");
    await c.close();
  }

  // 20) What the game used to save comes across: the old streak becomes one
  //     kit record a day, a finished 4x4 Easy grid keeps its full score, the
  //     settings move to the new keys, and the old keys are gone.
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await p.waitForSelector("#grid .cell");
    await p.evaluate((d) => {
      const g = window.game._debug;
      const old = g.legacyPuzzle(4, "easy", d.yesterday);
      // Yesterday's 4x4 Easy daily, finished under the old scheme with one hint.
      const hintAt = [...Array(16).keys()].find((i) => !old.givens.includes(String(i)));
      localStorage.clear();
      localStorage.setItem("ws-streak", JSON.stringify({ count: 3, last: d.yesterday, best: 5 }));
      localStorage.setItem("ws-size", "5");
      localStorage.setItem("ws-mode", JSON.stringify("hard"));
      localStorage.setItem("ws-help-seen", "1");
      localStorage.setItem("ws-p:daily:4:easy:" + d.yesterday, JSON.stringify({ cells: old.sol, hints: 1, hinted: [String(hintAt)], elapsed: 83, done: true }));
      localStorage.setItem("ws-p:daily:5:hard:" + d.before, JSON.stringify({ cells: "x".repeat(25), hints: 0, hinted: [], elapsed: 10, done: true }));
      localStorage.setItem("ws-p:free:4:easy:7", JSON.stringify({ cells: " ".repeat(16), hints: 0, hinted: [], elapsed: 4, done: false }));
    }, dates);
    await p.reload();
    await p.waitForSelector("#grid .cell");
    assert(await p.$eval("#helpBack", (e) => e.classList.contains("hidden")), "help-seen carried across");
    const moved = await p.evaluate((d) => {
      const get = (k) => JSON.parse(localStorage.getItem(k));
      return {
        keys: Object.keys(localStorage).sort(),
        y: get("wordsquare:daily:" + d.yesterday), b: get("wordsquare:daily:" + d.before), t: get("wordsquare:daily:" + d.third),
        size: get("wordsquare:size"), mode: get("wordsquare:mode"), streak: window.game._debug.daily.streak()
      };
    }, dates);
    assert(moved.keys.every((k) => !k.startsWith("ws-")), `old keys removed, still have ${moved.keys.filter((k) => k.startsWith("ws-")).join(" ")}`);
    assert(moved.y && moved.y.score === 9 && moved.y.max === 10 && moved.y.recap.time === 83 && moved.y.recap.hints === 1 && moved.y.recap.words.length >= 4,
      `yesterday's finished grid keeps its score, got ${JSON.stringify(moved.y)}`);
    assert(moved.b && moved.b.score === null && moved.b.max === null && moved.b.recap.migrated, `a day solved at another size is kept as solved, got ${JSON.stringify(moved.b)}`);
    assert(moved.t && moved.t.max === null, "the third streak day is kept as solved");
    assert(moved.size === 5 && moved.mode === "hard", "settings moved to the new keys");
    assert(moved.streak === 3, `the streak continues unbroken, got ${moved.streak}`);
    await p.click("#dailyLinks a[data-go=past]");
    assert(await p.$eval(`#pastList a[data-daily="${dates.yesterday}"] .s`, (e) => e.textContent) === "9 / 10", "past list shows the migrated score");
    assert(await p.$eval(`#pastList a[data-daily="${dates.before}"] .s`, (e) => e.textContent) === "Solved", "past list shows a solved day without a score");
    await p.click(`#pastList a[data-daily="${dates.before}"]`);
    await p.waitForSelector("#winBack:not(.hidden)");
    assert((await p.$eval("#winScore", (e) => e.textContent)) === "Solved", "a solved day without a score says so");
    assert(await p.$eval("#winShare", (e) => e.classList.contains("hidden")), "nothing to share for it");
    await c.close();
  }

  // 21) A small phone: nothing scrolls sideways, and the daily line leaves the
  //     whole board, the tray and the buttons on screen.
  {
    const c = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await p.waitForSelector("#grid .cell");
    await p.click("#helpClose");
    const fit = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        links: r("#dailyLinks").height, actions: r(".actions").bottom, board: r("#board").bottom,
        cell: parseInt(getComputedStyle(document.getElementById("board")).getPropertyValue("--cell"), 10)
      };
    });
    assert(fit.scrollWidth <= 375, `no sideways scroll at 375px, got ${fit.scrollWidth}`);
    assert(fit.links > 0 && fit.actions <= 667 && fit.board <= 667, `everything on a 375x667 screen, got ${JSON.stringify(fit)}`);
    assert(fit.cell >= 60, `the grid keeps a usable size, got ${fit.cell}px squares`);
    await c.close();
  }

  assert(errors.length === 0, "page errors: " + errors.join(" | "));
  await browser.close();
  server.close();
  console.log(`PASS — banks ${JSON.stringify(bankCheck.counts)} verified; play/hint/solve/reload, daily draw, first score kept, streak, migration, past puzzles, address, 375px fit OK`);
}

run().catch((err) => { console.error("FAIL —", err.message); process.exit(1); });
