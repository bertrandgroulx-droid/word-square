// Word Square — game module.
// A factory: index.html calls createWordSquare(ctx).start().
// ctx = { data, storage }, where data is the generated puzzles.js payload.
window.createWordSquare = function (ctx) {
  "use strict";

  var BANK = ctx.data.BANK;
  var store = ctx.storage;

  // ---- tunables ----
  var CONFIG = {
    givens: { 4: 6, 5: 9 },   // how many letters a puzzle starts with
    cellMin: 34, cellMax: 92, // grid squares clamp to this range, in px
    pipStrip: 18,             // px reserved for each strip of pips
    toastMs: 1600,
    popMs: 120
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    size4: $("size4"), size5: $("size5"),
    modeEasy: $("modeEasy"), modeHard: $("modeHard"), helpBtn: $("helpBtn"),
    puzLabel: $("puzLabel"), timer: $("timer"),
    boardWrap: document.querySelector(".board-wrap"),
    board: $("board"), grid: $("grid"), pipsR: $("pipsR"), pipsB: $("pipsB"),
    tray: $("tray"),
    hintBtn: $("hintBtn"), shuffleBtn: $("shuffleBtn"), clearBtn: $("clearBtn"), newBtn: $("newBtn"),
    helpBack: $("helpBack"), helpClose: $("helpClose"),
    winBack: $("winBack"), winSub: $("winSub"), winTime: $("winTime"),
    winHints: $("winHints"), winStreak: $("winStreak"), winWords: $("winWords"),
    winShare: $("winShare"), winNext: $("winNext"),
    toast: $("toast")
  };

  // Dictionaries, one per size — what counts as a word when a line is full.
  var DICT = { 4: new Set(ctx.data.WORDS[4]), 5: new Set(ctx.data.WORDS[5]) };

  // ---- state ----
  var n = 4;              // grid size
  var mode = "easy";      // "easy" (mirrored square) | "hard" (strict square)
  var puzzle = null;      // { id, kind, size, sol, givens, dateKey }
  var cells = [];         // grid letters, "" when empty; length n*n
  var tray = [];          // [{ ch, cell }] — cell is the index it sits in, or -1
  var hinted = {};        // cell index -> true, for the share grid
  var sel = 0;            // selected cell index
  var dir = "across";     // typing direction
  var hints = 0;
  var elapsed = 0;        // seconds
  var running = false;
  var done = false;
  var tickId = null;
  var toastId = null;

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

  // ---- puzzle construction ---------------------------------------------------
  function localDateKey(d) {
    var p = function (x) { return String(x).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function dayNumber(d) {
    // Count calendar days off the LOCAL date, so the puzzle turns over at local
    // midnight and stays monotonic across new year.
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }

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
    // The level is part of the id, so each difficulty keeps its own daily
    // puzzle and its own saved progress.
    var id = kind + ":" + size + ":" + level + ":" + (kind === "daily" ? dateKey : idx);
    return {
      id: id, kind: kind, size: size, level: level, index: idx, dateKey: dateKey,
      sol: sol, givens: pickGivens(size, rng(hash32(id)))
    };
  }

  function dailyFor(size, level, when) {
    var d = when || new Date();
    return makePuzzle("daily", size, level, dayNumber(d), localDateKey(d));
  }
  function randomFor(size, level) {
    return makePuzzle("free", size, level, Math.floor(Math.random() * BANK[size][level].length), null);
  }

  // ---- storage ---------------------------------------------------------------
  function read(key, fallback) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { store.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ }
  }
  function progressKey(p) { return "ws-p:" + p.id; }

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

  function bumpStreak(dateKey) {
    var st = read("ws-streak", { count: 0, last: null, best: 0 });
    if (st.last === dateKey) return st;                     // already counted today
    var y = new Date(dateKey + "T12:00:00");
    y.setDate(y.getDate() - 1);
    st.count = st.last === localDateKey(y) ? st.count + 1 : 1;
    st.last = dateKey;
    st.best = Math.max(st.best || 0, st.count);
    write("ws-streak", st);
    return st;
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
  function rowStr(r) {
    var s = "";
    for (var c = 0; c < n; c++) s += cells[r * n + c] || " ";
    return s;
  }
  function colStr(c) {
    var s = "";
    for (var r = 0; r < n; r++) s += cells[r * n + c] || " ";
    return s;
  }
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

  function renderMeta() {
    els.puzLabel.innerHTML = "";
    if (puzzle.kind === "daily") {
      els.puzLabel.textContent = "Daily · " + puzzle.dateKey;
      els.puzLabel.removeAttribute("role");
      els.puzLabel.classList.remove("link");
    } else {
      // Practice puzzles need a way home, or the daily one is stranded.
      els.puzLabel.textContent = "Practice #" + (puzzle.index + 1) + " · ";
      var a = document.createElement("span");
      a.className = "link";
      a.textContent = "back to daily";
      els.puzLabel.appendChild(a);
      els.puzLabel.setAttribute("role", "button");
    }
    els.timer.textContent = mmss(elapsed);
    els.size4.classList.toggle("active", n === 4);
    els.size5.classList.toggle("active", n === 5);
    els.modeEasy.classList.toggle("active", mode === "easy");
    els.modeHard.classList.toggle("active", mode === "hard");
    els.hintBtn.disabled = done;
    els.clearBtn.disabled = done;
  }

  function renderAll() { renderGrid(); renderPips(); renderTray(); renderMeta(); }

  function pop(i) {
    var el = els.grid.children[i];
    if (!el) return;
    el.classList.add("pop");
    setTimeout(function () { el.classList.remove("pop"); }, CONFIG.popMs);
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastId);
    toastId = setTimeout(function () { els.toast.classList.remove("show"); }, CONFIG.toastMs);
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

  // ---- winning ---------------------------------------------------------------
  function win() {
    if (done) return;
    done = true;
    running = false;
    saveProgress();

    var st = puzzle.kind === "daily" ? bumpStreak(puzzle.dateKey) : read("ws-streak", { count: 0 });
    els.winSub.textContent = puzzle.kind === "daily"
      ? "Daily puzzle · " + puzzle.dateKey
      : "Practice puzzle #" + (puzzle.index + 1);
    els.winTime.textContent = mmss(elapsed);
    els.winHints.textContent = String(hints);
    els.winStreak.textContent = String(st.count || 0);

    els.winWords.innerHTML = "";
    var words = [], seen = {};
    for (var k = 0; k < n; k++) {
      // Some squares read the same down as across; show each word once.
      [rowStr(k), colStr(k)].forEach(function (w) {
        if (!seen[w]) { seen[w] = true; words.push(w); }
      });
    }
    words.forEach(function (w) {
      var s = document.createElement("span");
      s.textContent = w;
      els.winWords.appendChild(s);
    });

    renderAll();
    setTimeout(function () { els.winBack.classList.remove("hidden"); }, 260);
  }

  function shareText() {
    var lines = [];
    for (var r = 0; r < n; r++) {
      var row = "";
      for (var c = 0; c < n; c++) {
        var i = r * n + c;
        row += puzzle.givens[i] ? "🟦" : hinted[i] ? "🟨" : "🟩";
      }
      lines.push(row);
    }
    var head = "Word Square " + n + "×" + n + " · " +
      (puzzle.kind === "daily" ? puzzle.dateKey : "practice");
    var tail = mmss(elapsed) + (hints ? " · " + hints + " hint" + (hints > 1 ? "s" : "") : " · no hints");
    return head + "\n" + lines.join("\n") + "\n" + tail;
  }

  function share() {
    var text = shareText();
    var ok = function () { toast("Result copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { toast("Copy failed"); });
    } else {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) { toast("Copy failed"); }
      document.body.removeChild(ta);
    }
  }

  // ---- events ----------------------------------------------------------------
  function onGridClick(e) {
    var t = e.target.closest ? e.target.closest(".cell") : null;
    if (!t) return;
    var i = +t.dataset.i;
    if (puzzle.givens[i] || done) { sel = i; renderGrid(); return; }
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

  function onKey(e) {
    if (!els.winBack.classList.contains("hidden") || !els.helpBack.classList.contains("hidden")) {
      if (e.key === "Escape") { els.winBack.classList.add("hidden"); els.helpBack.classList.add("hidden"); }
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

  function setSize(size) {
    if (size === n && puzzle) return;
    write("ws-size", size);
    load(dailyFor(size, mode));
  }
  function setMode(level) {
    if (level === mode && puzzle) return;
    write("ws-mode", level);
    load(dailyFor(n, level));
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
    els.shuffleBtn.addEventListener("click", function () { shuffle(tray); renderTray(); });
    els.clearBtn.addEventListener("click", clearAll);
    els.newBtn.addEventListener("click", function () { load(randomFor(n, mode)); });
    els.puzLabel.addEventListener("click", function () {
      if (puzzle.kind !== "daily") load(dailyFor(n, mode));
    });
    els.helpBtn.addEventListener("click", function () { els.helpBack.classList.remove("hidden"); });
    els.helpClose.addEventListener("click", function () {
      els.helpBack.classList.add("hidden");
      write("ws-help-seen", 1);
    });
    els.winShare.addEventListener("click", share);
    els.winNext.addEventListener("click", function () {
      els.winBack.classList.add("hidden");
      load(randomFor(n, mode));
    });
    [els.helpBack, els.winBack].forEach(function (b) {
      b.addEventListener("click", function (e) { if (e.target === b) b.classList.add("hidden"); });
    });
    var refit = function () { sizeBoard(); sizeTray(tray.length); };
    window.addEventListener("resize", refit);
    window.addEventListener("orientationchange", function () { setTimeout(refit, 150); });
  }

  // ---- start -----------------------------------------------------------------
  function start() {
    n = +read("ws-size", 4) === 5 ? 5 : 4;
    mode = read("ws-mode", "easy") === "hard" ? "hard" : "easy";
    bind();
    load(dailyFor(n, mode));
    if (!read("ws-help-seen", 0)) els.helpBack.classList.remove("hidden");
  }

  return {
    start: start,
    // exposed for the smoke test
    _debug: {
      solve: function () {
        clearAll();
        for (var i = 0; i < n * n; i++) if (!puzzle.givens[i]) place(i, puzzle.sol[i]);
      },
      state: function () {
        return { n: n, mode: mode, id: puzzle.id, cells: serialize(), done: done, hints: hints };
      }
    }
  };
};
