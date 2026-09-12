// Rebuild puzzles.js: fetch the source word lists, search for double word
// squares, and write the puzzle banks plus the dictionary the game validates
// against.
// Run: npm run generate            (needs network; caches downloads in .cache/)
//
// A "double word square" is a grid where every row AND every column is a word.
// Two shapes of them matter here, and they are the game's two difficulty levels:
//
//   Easy — a MIRRORED square, where column k spells the same word as row k.
//          Half the grid is a reflection of the other half, so a solved row
//          hands you a column for free.
//
//   Hard — a STRICT square, where no row matches any column. Ten separate words
//          at 5x5, eight at 4x4, and no reflection to lean on.
//
// Strict squares are much rarer than mirrored ones, which is why the hard 5x5
// search reaches deeper into the frequency list to find enough of them.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../", import.meta.url).pathname);
const CACHE = path.join(ROOT, ".cache");

const SOURCES = {
  // A Scrabble dictionary (TWL) decides what counts as a real word. A plain
  // word list won't do: those carry proper nouns, so "MOORE" reads as valid.
  // Scrabble lists exclude proper nouns by definition.
  "twl.txt": "https://raw.githubusercontent.com/redbo/scrabble/master/dictionary.txt",
  // 50k words by frequency: decides which of them a player is likely to know.
  "en_50k.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
  // Profanity and first names, both filtered out of the pool.
  "bad.txt": "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en",
  "names1.txt": "https://raw.githubusercontent.com/dominictarr/random-name/master/first-names.txt",
  "names2.txt": "https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/first%20names/us.txt"
};

// One entry per bank the game loads. maxRank caps how obscure a word may be,
// want is how many puzzles to keep, and limit stops the search once it has
// collected that many matching squares to choose between.
const BANKS = [
  { n: 4, mode: "easy", maxRank: 12000, want: 200, limit: 40000, timeMs: 60000 },
  { n: 4, mode: "hard", maxRank: 12000, want: 200, limit: 40000, timeMs: 60000 },
  { n: 5, mode: "easy", maxRank: 15000, want: 200, limit: 40000, timeMs: 120000 },
  { n: 5, mode: "hard", maxRank: 30000, want: 200, limit: 40000, timeMs: 300000 }
];

// Is column k the same word as row k, for every k?
function isMirrored(sq, n) {
  const flat = sq.join("");
  for (let k = 0; k < n; k++) {
    let col = "";
    for (let j = 0; j < n; j++) col += flat[j * n + k];
    if (col !== sq[k]) return false;
  }
  return true;
}

// No row appears anywhere among the columns — not even out of position.
function isStrict(sq, n) {
  const flat = sq.join("");
  const cols = [];
  for (let k = 0; k < n; k++) {
    let col = "";
    for (let j = 0; j < n; j++) col += flat[j * n + k];
    cols.push(col);
  }
  return sq.every((row) => !cols.includes(row));
}

const KEEP = { easy: isMirrored, hard: isStrict };

async function fetchSources() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const [name, url] of Object.entries(SOURCES)) {
    const file = path.join(CACHE, name);
    if (fs.existsSync(file) && fs.statSync(file).size > 0) continue;
    process.stdout.write(`fetching ${name}… `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
}

const readCache = (f) => fs.readFileSync(path.join(CACHE, f), "utf8");
const lines = (s) => s.split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean);

// ---- the word pool ---------------------------------------------------------
function buildPools() {
  // There is deliberately NO first-names filter. An early version had one and
  // it threw away hundreds of ordinary words, WILL ROSE GRACE HOPE DAWN MAY
  // JACK among them, because thousands of English words are also somebody's
  // name. A player hit it in the sister game and was right to. It was redundant
  // as well as harmful: a Scrabble dictionary holds no proper nouns, so HELEN
  // and SANTA are already absent while WILL and ROSE are correctly present.
  const valid = new Set(lines(readCache("twl.txt")));

  const rank = new Map(); // word -> 1-based frequency rank
  readCache("en_50k.txt").split("\n").forEach((line, i) => {
    const w = line.split(" ")[0];
    if (w && !rank.has(w)) rank.set(w, i + 1);
  });

  const bad = new Set(lines(readCache("bad.txt")));
  // Slurs and unpleasantness the generic list misses, plus words that would
  // read badly staring out of a puzzle grid.
  for (const w of ["fags", "coon", "coons", "wank", "wanks", "spic", "spics", "kike", "kikes",
    "gook", "gooks", "dyke", "dykes", "negro", "negros", "chink", "chinks", "twats", "cunts",
    "jizz", "cums", "turd", "turds", "crap", "craps", "damn", "hell", "arse", "arses",
    "rape", "rapes", "raped", "nazi", "nazis", "dead", "died", "dies", "kill", "kills",
    "killed", "guns", "slut", "sluts", "whore"]) bad.add(w);

  // Read off the generated banks and excluded by hand: words that pass every
  // automatic filter but still read as a proper noun ("texas", "turks"), a
  // foreign borrowing ("casa"), or something you'd rather not stare at in a
  // puzzle. Re-check this list whenever the sources change.
  for (const w of ["casa", "homo", "piss", "shag", "psst", "shaw", "kane", "scum",
    "bubba", "burke", "hogan", "liang", "texas", "turks", "costa", "welsh", "trump",
    "pasha", "senor", "sarge", "takin", "prick", "urine", "asses", "slave",
    // Only ever excluded as a side effect of the first-names filter. Dropping
    // that filter lets them back, so name them properly.
    "fanny", "fannies", "randy", "dong", "dongs", "johnson", "johnsons",
    "sissy", "sissies", "cissy", "pooh"]) bad.add(w);

  // The same corpus writes contractions without the apostrophe, and some of
  // those fragments are in the dictionary as archaic or dialect words.
  const fragments = new Set(["aren", "cant", "dont", "isnt", "wont", "weve", "wasnt", "didnt",
    "hadnt", "arent", "youve", "youll", "youre", "theyd", "theyll", "theyre", "thats", "whats",
    "hasnt", "havent", "aint", "shes", "hes", "ive", "itll", "lets", "gonna", "wanna", "gotta",
    "dunno", "cmon", "yall", "didn", "doesn", "wouldn", "couldn", "shouldn", "hadn", "weren",
    "isn", "wasn", "mustn", "needn", "daren", "shan", "ain"]);

  const poolFor = (n, maxRank) => {
    const out = [];
    for (const [w, r] of rank) {          // Map keeps insertion order: common first
      if (w.length !== n || r > maxRank) continue;
      if (!/^[a-z]+$/.test(w)) continue;
      if (!valid.has(w)) continue;
      if (bad.has(w) || fragments.has(w)) continue;
      out.push(w);
    }
    return out;
  };
  return { poolFor, rank };
}

// ---- the search ------------------------------------------------------------
// Fill row by row. After i rows, each column holds an i-letter prefix that must
// still be extendable to a word; on the last row every column must BE a word.
// `keep` decides which finished squares are collected, so the time budget is
// spent gathering the shape this bank actually wants.
function search(words, n, { limit, timeMs, keep }) {
  const prefixes = new Set();
  const byFirst = new Map();
  for (const w of words) {
    for (let k = 0; k <= n; k++) prefixes.add(w.slice(0, k));
    if (!byFirst.has(w[0])) byFirst.set(w[0], []);
    byFirst.get(w[0]).push(w);
  }
  const wordSet = new Set(words);

  const found = [];
  let seen = 0;
  const deadline = Date.now() + timeMs;
  let timedOut = false;
  const rows = [];
  const cols = new Array(n).fill("");

  function place(i) {
    if (timedOut || found.length >= limit) return;
    if (Date.now() > deadline) { timedOut = true; return; }
    if (i === n) {
      seen++;
      if (keep(rows, n)) found.push(rows.slice());
      return;
    }

    const last = i === n - 1;
    // Column 0 constrains only the candidate's first letter, so whole
    // first-letter groups can be skipped at once.
    for (const [letter, group] of byFirst) {
      const c0 = cols[0] + letter;
      if (!(last ? wordSet.has(c0) : prefixes.has(c0))) continue;
      for (const w of group) {
        if (found.length >= limit || timedOut) return;
        if (rows.includes(w)) continue;          // no repeated words in a square
        let ok = true;
        for (let j = 1; j < n && ok; j++) {
          const p = cols[j] + w[j];
          ok = last ? wordSet.has(p) : prefixes.has(p);
        }
        if (!ok) continue;
        rows.push(w);
        for (let j = 0; j < n; j++) cols[j] += w[j];
        place(i + 1);
        rows.pop();
        for (let j = 0; j < n; j++) cols[j] = cols[j].slice(0, -1);
      }
    }
  }
  place(0);
  return { found, seen, timedOut };
}

// Favour squares built from words people actually know, and keep each bank
// varied: no two puzzles may share more than one word.
function pick(squares, count, rank) {
  const worst = (sq) => Math.max(...sq.map((w) => rank.get(w) || 1e9));
  const sum = (sq) => sq.reduce((a, w) => a + (rank.get(w) || 1e9), 0);
  const scored = squares
    .map((sq) => ({ sq, w: worst(sq), s: sum(sq) }))
    .sort((a, b) => a.w - b.w || a.s - b.s);
  const out = [];
  for (const { sq } of scored) {
    if (out.length >= count) break;
    const set = new Set(sq);
    if (out.some((o) => o.filter((w) => set.has(w)).length > 1)) continue;
    out.push(sq);
  }
  return out;
}

// ---- main ------------------------------------------------------------------
await fetchSources();
const { poolFor, rank } = buildPools();

// KEEP_BANK rebuilds the dictionary and leaves the puzzles exactly as they are.
// Widening the dictionary is a bug fix every player wants immediately; new
// puzzles would change today's daily under anyone half way through it. The two
// deserve to ship separately.
const keepBank = process.env.KEEP_BANK === "1";
const existing = keepBank
  ? (() => {
      const src = fs.readFileSync(path.join(ROOT, "puzzles.js"), "utf8");
      const sandbox = { window: {} };
      new Function("window", src.replace("window.WORD_SQUARE_DATA", "window.WORD_SQUARE_DATA"))(sandbox.window);
      return sandbox.window.WORD_SQUARE_DATA.BANK;
    })()
  : null;

const bank = { 4: {}, 5: {} };
const dict = {};
for (const { n, mode, maxRank, want, limit, timeMs } of BANKS) {
  const words = poolFor(n, maxRank);
  const t0 = Date.now();
  if (keepBank) {
    bank[n][mode] = existing[n][mode].map((flat) => flat.match(new RegExp(`.{${n}}`, "g")));
    if (!dict[n] || words.length > dict[n].length) dict[n] = words;
    console.log(`${n}x${n} ${mode}: pool ${words.length}, bank kept as is (${bank[n][mode].length} puzzles)`);
    continue;
  }
  const { found, seen, timedOut } = search(words, n, { limit, timeMs, keep: KEEP[mode] });
  const chosen = pick(found, want, rank);
  if (chosen.length < want) {
    console.warn(`  warning: wanted ${want} ${n}x${n} ${mode} puzzles, got ${chosen.length}`);
  }
  bank[n][mode] = chosen;
  // The dictionary for a size has to cover every bank at that size, so keep
  // the widest pool any of them used.
  if (!dict[n] || words.length > dict[n].length) dict[n] = words;
  console.log(`${n}x${n} ${mode}: pool ${words.length}, ${seen} squares seen, ${found.length} ${mode}${timedOut ? " (time-capped)" : ""}, kept ${chosen.length} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("  e.g. " + chosen.slice(0, 2).map((s) => s.join(" ")).join(" | "));
}

// Guard the two properties the game depends on: every word must be in the
// dictionary, and every puzzle must have the shape its bank promises.
for (const { n, mode } of BANKS) {
  const set = new Set(dict[n]);
  for (const sq of bank[n][mode]) {
    for (const w of sq) {
      if (!set.has(w)) throw new Error(`${n}x${n} ${mode}: "${w}" is missing from the dictionary`);
    }
    if (!KEEP[mode](sq, n)) throw new Error(`${n}x${n} ${mode}: "${sq.join(" ")}" is the wrong shape`);
  }
}

const flat = (sqs) => sqs.map((s) => s.join("")).join(" ");
const out = path.join(ROOT, "puzzles.js");
fs.writeFileSync(out, `// GENERATED FILE — do not edit by hand.
// Rebuild with: npm run generate   (see tools/generate.mjs)
//
// BANK[n].easy and BANK[n].hard hold solved n x n double word squares, one per
// string, rows concatenated. Easy squares are mirrored: column k spells the
// same word as row k. Hard squares are strict: no row matches any column.
// WORDS[n] is the dictionary a typed row or column is checked against: common
// English words, with contraction fragments removed. Words that happen to be
// names (WILL, ROSE, GRACE) are words and are kept; the Scrabble dictionary
// already excludes actual proper nouns.
window.WORD_SQUARE_DATA = {
  BANK: {
    4: {
      easy: "${flat(bank[4].easy)}".split(" "),
      hard: "${flat(bank[4].hard)}".split(" ")
    },
    5: {
      easy: "${flat(bank[5].easy)}".split(" "),
      hard: "${flat(bank[5].hard)}".split(" ")
    }
  },
  WORDS: {
    4: "${dict[4].join(" ")}".split(" "),
    5: "${dict[5].join(" ")}".split(" ")
  }
};
`);
console.log(`wrote puzzles.js — ${(fs.statSync(out).size / 1024).toFixed(1)} KB` +
  (keepBank ? " (dictionary only; puzzles untouched)" : ""));
