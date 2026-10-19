// Word Square — game module.
// A factory: index.html calls createWordSquare(ctx).start().
// ctx = { data, storage, now }, where data is the generated puzzles.js payload,
// storage is localStorage, and now (optional, for tests) returns the current
// Date. Needs shozbot-daily.js loaded first: it defines window.ShozDaily.
window.createWordSquare = function (ctx) {
  "use strict";

  var BANK = ctx.data.BANK;
  var store = ctx.storage;

  // The daily puzzle's settings. One puzzle a day, the same for everyone, at
  // this size and level; every other size and level is a random puzzle.
  var DEFAULT = { size: 4, level: "easy" };

  // The shared studio kit: which day it is and its number, the day's seed, one
  // saved record per day with the first score kept, the streak, the standard
  // wording and the share text. Everything it saves sits under "wordsquare:".
  var daily = window.ShozDaily.create({
    game: "word-square", title: "Word Square", storage: store, now: ctx.now
  });

  // ---- tunables ----
  var CONFIG = {
    givens: { 4: 6, 5: 9 },   // how many letters a puzzle starts with
    cellMin: 34, cellMax: 92, // grid squares clamp to this range, in px
    pipStrip: 18,             // px reserved for each strip of pips
    toastMs: 1600,
    linkToastMs: 1800,        // "Link copied" stays a touch longer
    shareBarMin: 365,         // px: below this the share icon leaves the top bar
    popMs: 120
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    size4: $("size4"), size5: $("size5"),
    modeEasy: $("modeEasy"), modeHard: $("modeHard"), helpBtn: $("helpBtn"), shareBtn: $("shareBtn"),
    puzLabel: $("puzLabel"), dailyLinks: $("dailyLinks"), timer: $("timer"),
    boardWrap: document.querySelector(".board-wrap"),
    board: $("board"), grid: $("grid"), pipsR: $("pipsR"), pipsB: $("pipsB"),
    tray: $("tray"),
    hintBtn: $("hintBtn"), shuffleBtn: $("shuffleBtn"), clearBtn: $("clearBtn"), newBtn: $("newBtn"),
    scoreBtn: $("scoreBtn"), winGrid: $("winGrid"),
    helpBack: $("helpBack"), helpClose: $("helpClose"),
    winBack: $("winBack"), winSub: $("winSub"), winScore: $("winScore"), winVerdict: $("winVerdict"),
    winStreak: $("winStreak"), winSaved: $("winSaved"), winStats: $("winStats"),
    winTime: $("winTime"), winHints: $("winHints"), winWords: $("winWords"),
    winRandom: $("winRandom"), winShare: $("winShare"), winPast: $("winPast"), winAgain: $("winAgain"),
    pastBack: $("pastBack"), pastList: $("pastList"), pastClose: $("pastClose"),
    toast: $("toast")
  };

  // Dictionaries, one per size — what counts as a word when a line is full.
  var DICT = { 4: new Set(ctx.data.WORDS[4]), 5: new Set(ctx.data.WORDS[5]) };

  // ---- state ----
  var n = 4;              // grid size
  var mode = "easy";      // "easy" (mirrored square) | "hard" (strict square)
  var puzzle = null;      // { id, kind, size, level, index, sol, givens, dateKey, meta }
  var cells = [];         // grid letters, "" when empty; length n*n
  var tray = [];          // [{ ch, cell }] — cell is the index it sits in, or -1
  var hinted = {};        // cell index -> true, for the score and the share grid
  var sel = 0;            // selected cell index
  var dir = "across";     // typing direction
  var hints = 0;
  var elapsed = 0;        // seconds
  var running = false;
  var done = false;
  var tickId = null;
  var toastId = null;
  var shown = null;       // the results on screen, for Share
  var lastRes = null;   // the result of the solve on screen, with its "first" flag

  // ---- seeded randomness -----------------------------------------------------
  // The same puzzle must lay out the same way on every device and every reload,
  // so givens and the opening tray order come from a hash of the puzzle id.
  function hash32(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor((rand || Math.random)() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- puzzle construction ---------------------------------------------------
  // Pick the cells that start filled. Every row and every column gets at least
  // one, otherwise a line would be pure guesswork: take a random permutation for
  // that guaranteed cover, then sprinkle the rest.
  function pickGivens(size, rand) {
    var perm = shuffle(
      Array.apply(null, Array(size)).map(function (_, i) { return i; }), rand
    );
    var chosen = {};
    for (var i = 0; i < size; i++) chosen[i * size + perm[i]] = true;

    var rest = [];
    for (var c = 0; c < size * size; c++) if (!chosen[c]) rest.push(c);
    shuffle(rest, rand);
    var want = Math.min(CONFIG.givens[size], size * size - 1);
    for (var k = 0; Object.keys(chosen).length < want && k < rest.length; k++) chosen[rest[k]] = true;
    return chosen;
  }

  function makePuzzle(kind, size, level, index, dateKey) {
    var bank = BANK[size][level];
    var idx = ((index % bank.length) + bank.length) % bank.length;
    var flat = bank[idx];                       // rows concatenated
    var sol = flat.split("");
    var id = kind + ":" + size + ":" + level + ":" + (kind === "daily" ? dateKey : idx);
    return {
      id: id, kind: kind, size: size, level: level, index: idx, dateKey: dateKey,
      sol: sol, givens: pickGivens(size, rng(hash32(id)))
    };
  }

  // Which grid is the day's. The bank is shuffled once per year with a seed
  // from the game's name and the year, and the day of the year walks that
  // order — so the same grid cannot come round again inside 200 days, which a
  // draw straight from the day's own seed could not promise with a bank this
  // size. Deterministic, so everyone gets the same one.
  function dailyIndex(size, level, meta) {
    var bank = BANK[size][level], order = [];
    for (var i = 0; i < bank.length; i++) order.push(i);
    var seed = daily.hash32("word-square:" + size + ":" + level + ":" + meta.date.getFullYear());
    order = daily.shuffle(order, daily.rng(seed));
    return order[(meta.number - 1) % bank.length];
  }
  function dailyFor(meta) {
    var p = makePuzzle("daily", DEFAULT.size, DEFAULT.level, dailyIndex(DEFAULT.size, DEFAULT.level, meta), meta.iso);
    p.meta = meta;
    return p;
  }
  function randomFor(size, level) {
    return makePuzzle("free", size, level, Math.floor(Math.random() * BANK[size][level].length), null);
  }

  // ---- storage ---------------------------------------------------------------
  // Everything sits under the kit's "wordsquare:" prefix, because every app on
  // shozbot.com shares one origin. The kit owns "daily:<date>"; the game adds
  // "size" and "mode" (the last settings chosen for random puzzles),
  // "help-seen", and "p:<puzzle id>" for a grid in progress.
  function read(key, fallback) { return daily.read(key, fallback); }
  function write(key, val) { daily.write(key, val); }
  function remove(key) {
    try { store.removeItem(daily.store + key); } catch (e) { /* private mode */ }
  }
  function progressKey(p) { return "p:" + p.id; }

  // Empty squares have to occupy a character, or the saved string stops lining
  // up with the grid it came from.
  function serialize() {
    return cells.map(function (c) { return c || " "; }).join("");
  }

  function saveProgress() {
    if (!puzzle) return;
    write(progressKey(puzzle), {
      cells: serialize(), hints: hints, hinted: Object.keys(hinted),
      elapsed: elapsed, done: done
    });
  }

  // ---- what the game used to save --------------------------------------------
  // Until 2026-10-12 there was a daily at every size and level, keyed by the
  // local date, with progress at "ws-p:<id>" and a streak at "ws-streak" that
  // counted a solve at any of the four. The kit keeps one record per day
  // instead. This runs once: it writes a record for every day the old streak
  // covered and for every finished daily still on the device, carries the
  // settings across, then clears the old keys so nothing is read twice.
  function readOld(key) {
    try { var raw = store.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  // How the old game chose a day's puzzle: days since the epoch, around the bank.
  function legacyPuzzle(size, level, isoDate) {
    var d = daily.parseIso(isoDate);
    if (!d) return null;
    var index = Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    return makePuzzle("daily", size, level, index, isoDate);
  }
  // The record for a day the old game counted: the full score where the finished
  // 4×4 Easy grid is still saved, otherwise only that it was solved.
  function legacyRecord(isoDate) {
    var saved = readOld("ws-p:daily:" + DEFAULT.size + ":" + DEFAULT.level + ":" + isoDate);
    var p = saved && saved.done && saved.cells ? legacyPuzzle(DEFAULT.size, DEFAULT.level, isoDate) : null;
    if (!p || saved.cells.length !== p.size * p.size) {
      return { score: null, max: null, results: [], recap: { migrated: true } };
    }
    var h = {};
    (saved.hinted || []).forEach(function (i) { h[i] = true; });
    return tally(p, saved.cells.split(""), h, saved.hints || 0, saved.elapsed || 0);
  }
  function migrate() {
    var old = [], i, k;
    try {
      for (i = 0; i < store.length; i++) { k = store.key(i); if (k && k.indexOf("ws-") === 0) old.push(k); }
    } catch (e) { return; }
    if (!old.length) return;

    var size = readOld("ws-size"), level = readOld("ws-mode");
    if (size === 4 || size === 5) write("size", size);
    if (level === "easy" || level === "hard") write("mode", level);
    if (readOld("ws-help-seen")) write("help-seen", 1);
    // Prove the new keys take before the old ones go, or a blocked store would
    // lose a streak rather than carry it.
    write("migrated", 1);
    if (read("migrated", 0) !== 1) return;

    // The streak: a record for each of its days, ending on the day it last counted.
    var st = readOld("ws-streak");
    var last = st && st.last ? daily.parseIso(st.last) : null;
    for (i = 0; last && i < (st.count || 0); i++) {
      var m = daily.metaFor(daily.addDays(last, -i));
      daily.save(m, legacyRecord(m.iso));
    }
    // Any other finished daily still on the device, at any size and level.
    old.forEach(function (key) {
      var mm = /^ws-p:daily:\d:\w+:(\d{4}-\d\d-\d\d)$/.exec(key);
      var saved = mm ? readOld(key) : null;
      var d = saved && saved.done ? daily.parseIso(mm[1]) : null;
      if (d && d <= daily.today()) daily.save(daily.metaFor(d), legacyRecord(mm[1]));
    });
    old.forEach(function (key) { try { store.removeItem(key); } catch (e) { /* ignore */ } });
  }

  // ---- loading a puzzle ------------------------------------------------------
  function load(p) {
    puzzle = p;
    n = p.size;
    mode = p.level;
    cells = p.sol.map(function (ch, i) { return p.givens[i] ? ch : ""; });
    hinted = {};
    hints = 0;
    elapsed = 0;
    done = false;
    lastRes = null;

    // Tray holds exactly the letters the player still has to place.
    var seedRand = rng(hash32(p.id + ":tray"));
    tray = shuffle(
      p.sol.filter(function (_, i) { return !p.givens[i]; })
           .map(function (ch) { return { ch: ch, cell: -1 }; }),
      seedRand
    );

    var saved = read(progressKey(p), null);
    if (saved && saved.cells && saved.cells.length === n * n) restore(saved);

    sel = firstEmpty(0);
    dir = "across";
    buildGrid();
    renderAll();
    running = !done;
    startTick();
  }

  // Re-seat the saved letters through the same tray bookkeeping the UI uses, so
  // a restored game can't end up with a tray that disagrees with the grid.
  function restore(saved) {
    for (var i = 0; i < n * n; i++) {
      var ch = saved.cells[i];
      if (!ch || ch === " " || puzzle.givens[i]) continue;
      var slot = freeTrayFor(ch);
      if (!slot) continue;               // stale save; skip the letter
      slot.cell = i;
      cells[i] = ch;
    }
    hints = saved.hints || 0;
    (saved.hinted || []).forEach(function (i) { hinted[i] = true; });
    elapsed = saved.elapsed || 0;
    done = !!saved.done;
  }

  function freeTrayFor(ch) {
    for (var i = 0; i < tray.length; i++) if (tray[i].ch === ch && tray[i].cell < 0) return tray[i];
    return null;
  }

  // ---- where to go: today, a past day, random ---------------------------------
  // The address says which puzzle is showing, so a day can be linked and a
  // reload comes back to the same place: "?daily=2026-10-12", "?past",
  // "?practice", and nothing at all for today's.
  function todayIso() { return daily.iso(daily.today()); }
  function setUrl(q) {
    try { history.replaceState(null, "", q || location.pathname); } catch (e) { /* file:// */ }
  }
  function urlFor(p) {
    if (!p) return "";
    if (p.kind !== "daily") return "?practice";
    return p.meta.iso === todayIso() ? "" : "?daily=" + p.meta.iso;
  }

  // A day that has already been played opens on its results; Play it again
  // starts it over. opts.quiet loads the board without the results on top.
  function openDate(isoDate, opts) {
    var d = daily.parseIso(isoDate);
    if (!d) return openToday();
    if (d > daily.today()) { openToday({ quiet: true }); return showPast(); }
    var meta = daily.metaFor(d);
    closeAll();
    load(dailyFor(meta));
    setUrl(urlFor(puzzle));
    var r = daily.record(meta.iso);
    // A played day shows its finished grid, with the score behind its button:
    // from the saved progress if it is still here, else rebuilt from the
    // record. Only a record with no grid to show goes straight to the results.
    if (r && !done && !showKept(meta, r) && !(opts && opts.quiet)) showResults(fromRecord(meta, r));
  }
  function openToday(opts) { openDate(todayIso(), opts); }

  function startRandom(size, level) {
    closeAll();
    load(randomFor(size, level));
    setUrl("?practice");
  }

  // Play it again: the kept score stays; the grid starts over.
  function replay() {
    closeAll();
    remove(progressKey(puzzle));
    load(puzzle.kind === "daily" ? dailyFor(puzzle.meta) : puzzle);
  }

  function route() {
    var q = new URLSearchParams(location.search);
    if (q.has("practice")) {
      var size = +read("size", DEFAULT.size) === 5 ? 5 : 4;
      var level = read("mode", DEFAULT.level) === "hard" ? "hard" : "easy";
      return startRandom(size, level);
    }
    if (q.has("past")) { openToday({ quiet: true }); return showPast(); }
    if (q.get("daily")) return openDate(q.get("daily"));
    openToday();
  }

  // ---- placing and clearing --------------------------------------------------
  function place(i, ch) {
    if (done || puzzle.givens[i]) return false;
    var slot = freeTrayFor(ch);
    if (!slot) {
      // The letter may already be sitting in another cell the player can spare.
      toast("No " + ch.toUpperCase() + " left in the tray");
      return false;
    }
    if (cells[i]) clear(i);
    slot.cell = i;
    cells[i] = ch;
    pop(i);
    afterChange();
    return true;
  }

  function clear(i) {
    if (done || puzzle.givens[i] || !cells[i]) return false;
    for (var k = 0; k < tray.length; k++) if (tray[k].cell === i) { tray[k].cell = -1; break; }
    cells[i] = "";
    delete hinted[i];
    afterChange();
    return true;
  }

  function clearAll() {
    if (done) return;
    for (var i = 0; i < n * n; i++) if (!puzzle.givens[i]) cells[i] = "";
    tray.forEach(function (t) { t.cell = -1; });
    hinted = {};
    sel = firstEmpty(0);
    afterChange();
  }

  function afterChange() {
    renderAll();
    saveProgress();
    if (isSolved()) win();
  }

  // ---- reading the grid ------------------------------------------------------
  function lineOf(grid, size, k, across) {
    var s = "";
    for (var j = 0; j < size; j++) s += grid[across ? k * size + j : j * size + k] || " ";
    return s;
  }
  function rowStr(r) { return lineOf(cells, n, r, true); }
  function colStr(c) { return lineOf(cells, n, c, false); }
  function isWord(s) { return s.indexOf(" ") < 0 && DICT[n].has(s); }

  function isSolved() {
    for (var i = 0; i < n * n; i++) if (!cells[i]) return false;
    for (var k = 0; k < n; k++) if (!isWord(rowStr(k)) || !isWord(colStr(k))) return false;
    return true;
  }

  function firstEmpty(from) {
    for (var k = 0; k < n * n; k++) {
      var i = (from + k) % (n * n);
      if (!cells[i] && !puzzle.givens[i]) return i;
    }
    return from % (n * n);
  }

  // Move on to the next cell the player can actually type in: along the current
  // line first, then anywhere, so filling never dead-ends on a given.
  function advance() {
    var r = Math.floor(sel / n), c = sel % n;
    for (var k = 1; k < n; k++) {
      var i = dir === "across" ? r * n + ((c + k) % n) : (((r + k) % n) * n + c);
      if (!cells[i] && !puzzle.givens[i]) { sel = i; return; }
    }
    sel = firstEmpty(sel + 1);
  }

  function step(dr, dc) {
    var r = Math.floor(sel / n), c = sel % n;
    r = (r + dr + n) % n;
    c = (c + dc + n) % n;
    sel = r * n + c;
    dir = dr ? "down" : "across";
    renderGrid();
  }

  // ---- hints -----------------------------------------------------------------
  function hint() {
    if (done) return;
    var empties = [];
    for (var i = 0; i < n * n; i++) if (!cells[i] && !puzzle.givens[i]) empties.push(i);
    if (!empties.length) { toast("Grid is full — check the dots"); return; }

    var target = empties[Math.floor(Math.random() * empties.length)];
    var want = puzzle.sol[target];

    // The needed letter might be sitting in a cell where it doesn't belong.
    // Reclaim it from there rather than refusing the hint.
    if (!freeTrayFor(want)) {
      var taken = null;
      for (var k = 0; k < n * n && taken === null; k++) {
        if (cells[k] === want && !puzzle.givens[k] && puzzle.sol[k] !== want) taken = k;
      }
      if (taken === null) { toast("Every hint letter is already placed"); return; }
      clear(taken);
    }
    hints++;
    hinted[target] = true;
    place(target, want);
    sel = firstEmpty(target);
    renderAll();
  }

  // ---- rendering -------------------------------------------------------------
  function buildGrid() {
    els.grid.style.setProperty("--n", n);
    els.pipsB.style.setProperty("--n", n);
    els.grid.innerHTML = "";
    els.pipsR.innerHTML = "";
    els.pipsB.innerHTML = "";

    for (var i = 0; i < n * n; i++) {
      var d = document.createElement("div");
      d.className = "cell";
      d.setAttribute("role", "gridcell");
      d.dataset.i = i;
      els.grid.appendChild(d);
    }
    for (var k = 0; k < n; k++) {
      els.pipsR.appendChild(pipEl("r" + k));
      els.pipsB.appendChild(pipEl("b" + k));
    }
    sizeBoard();
  }
  function pipEl(id) {
    var p = document.createElement("div");
    p.className = "pip";
    p.dataset.p = id;
    p.appendChild(document.createElement("i"));
    return p;
  }

  // Fit the board to whatever vertical space the rest of the UI leaves over.
  function sizeBoard() {
    var wrap = els.boardWrap;
    var gap = 6;
    var avail = function (px) { return (px - CONFIG.pipStrip - gap * n) / n; };
    var byW = avail(wrap.clientWidth);
    var byH = avail(wrap.clientHeight);
    var cell = Math.floor(Math.min(byW, byH));
    cell = Math.max(CONFIG.cellMin, Math.min(CONFIG.cellMax, cell));
    els.board.style.setProperty("--cell", cell + "px");
  }

  function renderGrid() {
    var kids = els.grid.children;
    var selR = Math.floor(sel / n), selC = sel % n;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var r = Math.floor(i / n), c = i % n;
      var onBeam = dir === "across" ? r === selR : c === selC;
      el.textContent = cells[i] || "";
      el.classList.toggle("given", !!puzzle.givens[i]);
      el.classList.toggle("sel", i === sel && !done);
      el.classList.toggle("beam", onBeam && i !== sel && !done);
      el.setAttribute("aria-label",
        "Row " + (r + 1) + " column " + (c + 1) + ", " +
        (cells[i] ? cells[i].toUpperCase() + (puzzle.givens[i] ? " (given)" : "") : "empty"));
    }
  }

  function renderPips() {
    for (var k = 0; k < n; k++) {
      els.pipsR.children[k].classList.toggle("on", isWord(rowStr(k)));
      els.pipsB.children[k].classList.toggle("on", isWord(colStr(k)));
    }
  }

  // Fit the tray to the width available: one row while the letters are few,
  // two balanced rows once they aren't, rather than a ragged wrap.
  function sizeTray(count) {
    var gap = 6;
    var perRow = count <= 10 ? count : Math.ceil(count / 2);
    var w = (els.tray.clientWidth - (perRow - 1) * gap) / perRow;
    w = Math.max(26, Math.min(44, Math.floor(w)));
    els.tray.style.setProperty("--tile", w + "px");
  }

  function renderTray() {
    sizeTray(tray.length);
    els.tray.innerHTML = "";
    tray.forEach(function (t, idx) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tile" + (t.cell >= 0 ? " spent" : "");
      b.textContent = t.ch;
      b.dataset.t = idx;
      b.setAttribute("aria-label", "Place letter " + t.ch.toUpperCase());
      els.tray.appendChild(b);
    });
  }

  // The daily line: what is showing, and links to the other two places to go.
  var PLACES = {
    today: ["Today’s puzzle", "./", function () { openToday(); }],
    past: ["Past puzzles", "?past", function () { showPast(); }],
    random: ["Random puzzles", "?practice", function () { startRandom(n, mode); }]
  };
  function renderMeta() {
    var isDaily = puzzle.kind === "daily";
    els.puzLabel.innerHTML = isDaily
      ? "<b>Daily No. " + puzzle.meta.number + "</b> · " + esc(daily.fmtShort(puzzle.meta.date))
      : "<b>Random puzzles</b> · #" + (puzzle.index + 1);
    els.dailyLinks.innerHTML = (isDaily ? ["past", "random"] : ["today", "past"]).map(function (k) {
      return '<a href="' + PLACES[k][1] + '" data-go="' + k + '">' + PLACES[k][0] + "</a>";
    }).join("");
    placeShare();   // the share icon lives in this row on a narrow screen
    els.timer.textContent = mmss(elapsed);
    els.size4.classList.toggle("active", n === 4);
    els.size5.classList.toggle("active", n === 5);
    els.modeEasy.classList.toggle("active", mode === "easy");
    els.modeHard.classList.toggle("active", mode === "hard");
    els.hintBtn.disabled = done;
    els.clearBtn.disabled = done;
    // A solved grid swaps its tools for the one thing left to do.
    [els.hintBtn, els.shuffleBtn, els.clearBtn].forEach(function (b) { b.classList.toggle("hidden", done); });
    els.scoreBtn.classList.toggle("hidden", !done);
  }

  function renderAll() { renderGrid(); renderPips(); renderTray(); renderMeta(); }

  function pop(i) {
    var el = els.grid.children[i];
    if (!el) return;
    el.classList.add("pop");
    setTimeout(function () { el.classList.remove("pop"); }, CONFIG.popMs);
  }

  function toast(msg, ms, wrap) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("wrap", !!wrap);
    els.toast.classList.add("show");
    clearTimeout(toastId);
    toastId = setTimeout(function () { els.toast.classList.remove("show"); }, ms || CONFIG.toastMs);
  }

  // ---- timer -----------------------------------------------------------------
  function mmss(s) {
    var m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }
  function startTick() {
    clearInterval(tickId);
    tickId = setInterval(function () {
      if (!running || done || document.hidden) return;
      elapsed++;
      els.timer.textContent = mmss(elapsed);
      if (elapsed % 10 === 0) saveProgress();
    }, 1000);
  }

  // ---- scoring ---------------------------------------------------------------
  // What a finished grid scores: a point for every letter you placed yourself.
  // The tray letters are the most there is — 10 at 4×4, 16 at 5×5 — and a hint
  // costs the point for its square. The recap holds what the results screen
  // shows again later: the time, the hints, the words, and the share grid.
  function tally(p, grid, hintedCells, hintCount, seconds) {
    var size = p.size, results = [], score = 0, rows = [], words = [], seen = {}, i;
    for (i = 0; i < size * size; i++) {
      if (p.givens[i]) continue;
      var pt = hintedCells[i] ? 0 : 1;
      results.push(pt);
      score += pt;
    }
    for (var r = 0; r < size; r++) {
      var row = "";
      for (var c = 0; c < size; c++) {
        i = r * size + c;
        row += p.givens[i] ? "🟦" : hintedCells[i] ? "🟨" : "🟩";
      }
      rows.push(row);
    }
    for (var k = 0; k < size; k++) {
      // Some squares read the same down as across; show each word once.
      [lineOf(grid, size, k, true), lineOf(grid, size, k, false)].forEach(function (w) {
        if (!seen[w]) { seen[w] = true; words.push(w); }
      });
    }
    return {
      score: score, max: results.length, results: results,
      // cells: the finished grid itself, so a past day can be shown again
      // whatever the draw does later (added 2026-10-12).
      recap: { time: seconds, hints: hintCount, words: words, squares: rows.join("\n"), cells: grid.map(function (c) { return c || " "; }).join("") }
    };
  }
  function boardResults() {
    var res = tally(puzzle, cells, hinted, hints, elapsed);
    res.meta = puzzle.meta || null;
    res.first = false;
    return res;
  }
  function fromRecord(meta, r) {
    return { meta: meta, first: false, score: r.score, max: r.max, results: r.results, recap: r.recap || {} };
  }

  // ---- showing a day that was played ------------------------------------------
  // A record made since 2026-10-12 carries its finished grid. One migrated from
  // the old game carries only its words, which is usually enough: find an order
  // of n of them as rows whose columns are all words too. A record with neither
  // (a day solved at another size before scores were kept) has no grid to show.
  function gridFromWords(words, size) {
    if (!words || words.length < size) return null;
    var set = {}; words.forEach(function (w) { set[w] = true; });
    var rows = [], used = {};
    function fits() {
      for (var c = 0; c < size; c++) {
        var col = "";
        for (var r = 0; r < size; r++) col += rows[r][c];
        if (!set[col]) return false;
      }
      return true;
    }
    function pick(depth) {
      if (depth === size) return fits();
      for (var i = 0; i < words.length; i++) {
        if (used[i] || words[i].length !== size) continue;
        used[i] = true; rows.push(words[i]);
        if (pick(depth + 1)) return true;
        rows.pop(); used[i] = false;
      }
      return false;
    }
    return pick(0) ? rows.join("").split("") : null;
  }
  function gridFromRecord(r, size) {
    var recap = r && r.recap ? r.recap : {};
    var grid = typeof recap.cells === "string" && recap.cells.length === size * size ? recap.cells.split("") : gridFromWords(recap.words, size);
    if (!grid || grid.some(function (ch) { return !ch || ch === " "; })) return null;
    var givens = {}, hinted = {};
    (recap.squares || "").split("\n").forEach(function (row, rIdx) {
      Array.from(row).forEach(function (sq, c) {
        var i = rIdx * size + c;
        if (sq === "\ud83d\udfe6") givens[i] = true;     // 🟦
        else if (sq === "\ud83d\udfe8") hinted[i] = true; // 🟨
      });
    });
    return { cells: grid, givens: givens, hinted: hinted };
  }
  // Put a kept day's finished grid on the board, read-only, with its score
  // behind the button. Returns false when the record has no grid to show.
  function showKept(meta, r) {
    var g = gridFromRecord(r, n);
    if (!g) return false;
    puzzle = Object.assign({}, puzzle, { givens: g.givens, sol: g.cells });
    cells = g.cells.slice();
    hinted = g.hinted;
    hints = r.recap.hints || 0;
    elapsed = r.recap.time || 0;
    done = true;
    running = false;
    tray.forEach(function (t) { t.cell = 0; });   // every letter is placed
    lastRes = fromRecord(meta, r);
    renderAll();
    return true;
  }

  // ---- winning ---------------------------------------------------------------
  function win() {
    if (done) return;
    done = true;
    running = false;
    saveProgress();

    var res = boardResults();
    if (puzzle.kind === "daily") res.first = daily.save(puzzle.meta, res).first;
    lastRes = res;
    renderAll();
    // The finished square stays on screen; the score waits behind the button
    // below it (Bertrand, 2026-10-12: see the completed game before the score).
    toast("Solved");
    els.scoreBtn.focus();
  }
  function showScore() { showResults(lastRes || boardResults()); }

  // The results, in the order every Shozbot daily uses: the score, a verdict,
  // the streak when there is one, whether it was saved, then the game's own
  // time, hints and words, then the ways on.
  function showResults(res) {
    var meta = res.meta, isDaily = !!(meta && meta.mode === "daily");
    var isToday = isDaily && meta.iso === todayIso();
    var recap = res.recap || {};
    var bare = res.max === null || res.max === undefined;   // migrated: solved, score unknown
    shown = res;

    els.winSub.textContent = isDaily ? daily.label(meta) : "Random puzzle";
    els.winScore.innerHTML = bare ? "Solved" : res.score + " <small>/ " + res.max + "</small>";
    els.winVerdict.textContent = bare ? "Solved before scores were kept." : daily.verdict(res.score, res.max, meta);
    var run = isToday ? daily.streakLine() : "";
    els.winStreak.textContent = run;
    els.winStreak.classList.toggle("hidden", !run);
    els.winSaved.textContent = daily.savedLine(meta, res.first);
    els.winSaved.classList.toggle("first", isDaily && !!res.first);

    els.winStats.classList.toggle("hidden", bare);
    els.winTime.textContent = mmss(recap.time || 0);
    els.winHints.textContent = String(recap.hints || 0);
    els.winWords.innerHTML = "";
    (recap.words || []).forEach(function (w) {
      var s = document.createElement("span");
      s.textContent = w;
      els.winWords.appendChild(s);
    });

    els.winRandom.textContent = isDaily ? "Play random puzzles" : "More random puzzles";
    els.winShare.classList.toggle("hidden", bare);
    els.winAgain.textContent = isDaily ? "Play it again" : "Today’s puzzle";
    els.winGrid.classList.toggle("hidden", !done);
    els.winBack.classList.remove("hidden");
    els.winRandom.focus();
  }

  function shareText(res) {
    var recap = res.recap || {};
    return daily.shareText({
      meta: res.meta, score: res.score, max: res.max,
      // The grid is several lines, so it starts on a line of its own.
      squares: recap.squares ? "\n" + recap.squares : ""
    });
  }
  function share() {
    if (!shown) return;
    daily.share(shareText(shown), els.winShare).then(function (how) {
      if (how === "failed") toast("Copy failed");
    });
  }

  // ---- sharing a link to this -------------------------------------------------
  // The icon at the top shares a link to what is on screen, as every Shozbot
  // phone app does (2026-10-19). A specific day's grid — in play, solved, or
  // on its results — gets the dated link, so it still opens the same puzzle
  // tomorrow; a random puzzle and the Past puzzles list get the plain address.
  // Always the shozbot.com address from the canonical link, never location:
  // this file is served from the old github.io address too, and saved progress
  // lives per address. (The Share button on the results shares the score text
  // and is a different thing.)
  function canonical() {
    var l = document.querySelector('link[rel="canonical"]');
    return l && l.href ? l.href : "https://shozbot.com/word-square/";
  }
  function shareLink() {
    var onList = !els.pastBack.classList.contains("hidden");
    var dated = puzzle && puzzle.kind === "daily" && !onList;
    return dated
      ? { url: canonical() + "?daily=" + puzzle.meta.iso, title: "Word Square · Daily No. " + puzzle.meta.number }
      : { url: canonical(), title: "Word Square" };
  }
  // A phone opens its share sheet; a laptop copies the link and says so; where
  // neither exists the link itself is shown.
  function shareThis() {
    var s = shareLink();
    if (navigator.share) { navigator.share({ title: s.title, url: s.url }).catch(function () {}); return; }
    var showLink = function () { toast(s.url, CONFIG.linkToastMs, true); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s.url).then(function () { toast("Link copied", CONFIG.linkToastMs); }, showLink);
      return;
    }
    showLink();
  }
  // Where the icon sits: left of the ? while the top bar has the room, which
  // it has from 365px up; narrower than that (320px, 360px Androids) the bar
  // is full and the icon rides the end of the Past/Random links row instead.
  function placeShare() {
    var narrow = window.innerWidth < CONFIG.shareBarMin;
    var want = narrow ? els.dailyLinks : els.helpBtn.parentNode;
    if (els.shareBtn.parentNode === want) return;
    if (narrow) want.appendChild(els.shareBtn); else want.insertBefore(els.shareBtn, els.helpBtn);
  }

  // ---- past puzzles ----------------------------------------------------------
  function scoreText(r) {
    if (!r) return "Not played";
    if (r.max === null || r.max === undefined) return "Solved";
    return r.score + " / " + r.max;
  }
  function showPast() {
    closeAll();
    setUrl("?past");
    var year = daily.today().getFullYear();
    els.pastList.innerHTML = daily.pastDays().map(function (m) {
      var when = (m.isToday ? "Today, " : "") + daily.fmtTiny(m.date) +
        (m.date.getFullYear() !== year ? ", " + m.date.getFullYear() : "");
      return '<li><a href="?daily=' + m.iso + '" data-daily="' + m.iso + '"' + (m.isToday ? ' class="today"' : "") + ">" +
        '<span class="n">No. ' + m.number + '</span><span class="d">' + esc(when) + "</span>" +
        '<span class="s' + (m.record ? " done" : "") + '">' + scoreText(m.record) + "</span></a></li>";
    }).join("");
    els.pastBack.classList.remove("hidden");
    els.pastBack.querySelector(".modal").scrollTop = 0;
  }

  function closeAll() {
    els.winBack.classList.add("hidden");
    els.pastBack.classList.add("hidden");
  }
  // Dismissing a panel puts the address back to the puzzle underneath it.
  function dismiss() {
    closeAll();
    setUrl(urlFor(puzzle));
  }

  // ---- events ----------------------------------------------------------------
  function onGridClick(e) {
    var t = e.target.closest ? e.target.closest(".cell") : null;
    if (!t) return;
    if (done) { showScore(); return; }   // a solved grid shows its results again
    var i = +t.dataset.i;
    if (puzzle.givens[i]) { sel = i; renderGrid(); return; }
    if (cells[i]) { clear(i); sel = i; renderGrid(); return; }
    if (i === sel) dir = dir === "across" ? "down" : "across";
    sel = i;
    renderGrid();
  }

  function onTrayClick(e) {
    var t = e.target.closest ? e.target.closest(".tile") : null;
    if (!t || done) return;
    var slot = tray[+t.dataset.t];
    if (!slot || slot.cell >= 0) return;
    if (puzzle.givens[sel]) sel = firstEmpty(sel);
    if (place(sel, slot.ch)) { advance(); renderGrid(); }
  }

  function anyOpen() {
    return [els.winBack, els.helpBack, els.pastBack].some(function (b) { return !b.classList.contains("hidden"); });
  }
  function onKey(e) {
    if (anyOpen()) {
      if (e.key === "Escape") { els.helpBack.classList.add("hidden"); dismiss(); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (/^[a-zA-Z]$/.test(k)) {
      e.preventDefault();
      if (puzzle.givens[sel]) sel = firstEmpty(sel);
      if (place(sel, k.toLowerCase())) { advance(); renderGrid(); }
    } else if (k === "Backspace" || k === "Delete") {
      e.preventDefault();
      if (cells[sel] && !puzzle.givens[sel]) { clear(sel); }
      else {
        var r = Math.floor(sel / n), c = sel % n;
        var prev = dir === "across" ? r * n + ((c - 1 + n) % n) : (((r - 1 + n) % n) * n + c);
        sel = prev;
        clear(prev);
      }
      renderGrid();
    } else if (k === "ArrowLeft") { e.preventDefault(); step(0, -1); }
    else if (k === "ArrowRight") { e.preventDefault(); step(0, 1); }
    else if (k === "ArrowUp") { e.preventDefault(); step(-1, 0); }
    else if (k === "ArrowDown") { e.preventDefault(); step(1, 0); }
    else if (k === " " || k === "Enter") { e.preventDefault(); dir = dir === "across" ? "down" : "across"; renderGrid(); }
  }

  // The size and level controls choose random puzzles. The daily is always
  // 4×4 Easy, so picking anything else deals a random puzzle at that setting,
  // and the choice is remembered for next time.
  function setSize(size) {
    if (size === n && puzzle) return;
    write("size", size);
    write("mode", mode);
    startRandom(size, mode);
  }
  function setMode(level) {
    if (level === mode && puzzle) return;
    write("size", n);
    write("mode", level);
    startRandom(n, level);
  }

  function bind() {
    els.grid.addEventListener("click", onGridClick);
    els.tray.addEventListener("click", onTrayClick);
    document.addEventListener("keydown", onKey);
    els.size4.addEventListener("click", function () { setSize(4); });
    els.size5.addEventListener("click", function () { setSize(5); });
    els.modeEasy.addEventListener("click", function () { setMode("easy"); });
    els.modeHard.addEventListener("click", function () { setMode("hard"); });
    els.hintBtn.addEventListener("click", hint);
    els.scoreBtn.addEventListener("click", showScore);
    els.winGrid.addEventListener("click", dismiss);
    els.shuffleBtn.addEventListener("click", function () { shuffle(tray); renderTray(); });
    els.clearBtn.addEventListener("click", clearAll);
    els.newBtn.addEventListener("click", function () { startRandom(n, mode); });
    els.dailyLinks.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[data-go]") : null;
      if (!a) return;
      e.preventDefault();
      PLACES[a.dataset.go][2]();
    });
    els.helpBtn.addEventListener("click", function () { els.helpBack.classList.remove("hidden"); });
    els.shareBtn.addEventListener("click", shareThis);
    els.helpClose.addEventListener("click", function () {
      els.helpBack.classList.add("hidden");
      write("help-seen", 1);
    });
    els.winRandom.addEventListener("click", function () { startRandom(n, mode); });
    els.winShare.addEventListener("click", share);
    els.winPast.addEventListener("click", showPast);
    els.winAgain.addEventListener("click", function () {
      if (puzzle.kind === "daily") replay(); else openToday();
    });
    els.pastClose.addEventListener("click", dismiss);
    els.pastList.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a[data-daily]") : null;
      if (!a) return;
      e.preventDefault();
      openDate(a.dataset.daily);
    });
    els.helpBack.addEventListener("click", function (e) { if (e.target === els.helpBack) els.helpBack.classList.add("hidden"); });
    [els.winBack, els.pastBack].forEach(function (b) {
      b.addEventListener("click", function (e) { if (e.target === b) dismiss(); });
    });
    var refit = function () { placeShare(); sizeBoard(); sizeTray(tray.length); };
    window.addEventListener("resize", refit);
    window.addEventListener("orientationchange", function () { setTimeout(refit, 150); });
  }

  // ---- start -----------------------------------------------------------------
  function start() {
    migrate();
    bind();
    route();
    if (!read("help-seen", 0)) els.helpBack.classList.remove("hidden");
  }

  return {
    start: start,
    // exposed for the smoke test
    _debug: {
      daily: daily,
      solve: function () {
        clearAll();
        for (var i = 0; i < n * n; i++) if (!puzzle.givens[i]) place(i, puzzle.sol[i]);
      },
      state: function () {
        return {
          n: n, mode: mode, id: puzzle.id, kind: puzzle.kind, iso: puzzle.meta ? puzzle.meta.iso : null,
          cells: serialize(), done: done, hints: hints
        };
      },
      dailyFor: function (isoDate) {
        var p = dailyFor(daily.metaFor(daily.parseIso(isoDate)));
        return { id: p.id, index: p.index, sol: p.sol.join(""), givens: Object.keys(p.givens) };
      },
      legacyPuzzle: function (size, level, isoDate) {
        var p = legacyPuzzle(size, level, isoDate);
        return { id: p.id, sol: p.sol.join(""), givens: Object.keys(p.givens) };
      },
      results: boardResults,
      shareText: function () { return shown ? shareText(shown) : ""; },
      shareLink: shareLink
    }
  };
};
