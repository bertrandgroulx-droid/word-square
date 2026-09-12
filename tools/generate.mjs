// Rebuild puzzles.js: fetch the source word lists, search for double word
// squares, and write the bank plus the dictionary the game validates against.
// Run: npm run generate            (needs network; caches downloads in .cache/)
//
// A "double word square" is a grid where every row AND every column is a word,
// and the two sets need not match — HEART across / HEAPS down is fine. They are
// harder to find than the classic symmetric square, which is why the search
// below prunes on column prefixes rather than enumerating grids.
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

// Per-size search settings. maxRank caps how obscure a word may be; want is how
// many puzzles land in the bank.
const SIZES = [
  { n: 4, maxRank: 12000, want: 200, timeMs: 60000 },
  { n: 5, maxRank: 15000, want: 200, timeMs: 180000 }
];

const LIMIT = 40000; // stop collecting raw squares past this many

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

  // Read off the generated bank and excluded by hand: words that pass every
  // automatic filter but still read as a proper noun ("texas", "turks"), a
  // foreign borrowing ("casa"), or something you'd rather not stare at in a
  // puzzle. Re-check this list whenever the sources change.
  for (const w of ["casa", "homo", "piss", "shag", "psst", "shaw", "kane", "scum",
    "bubba", "burke", "hogan", "liang", "texas", "turks", "costa", "welsh", "trump",
    "pasha", "senor", "sarge", "takin", "prick", "urine", "asses", "slave"]) bad.add(w);

  // A frequency list built from subtitles is full of first names.
  const names = new Set([...lines(readCache("names1.txt")), ...lines(readCache("names2.txt"))]);

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
      if (bad.has(w) || names.has(w) || fragments.has(w)) continue;
      out.push(w);
    }
    return out;
  };
  return { poolFor, rank };
}

// ---- the search ------------------------------------------------------------
// Fill row by row. After i rows, each column holds an i-letter prefix that must
// still be extendable to a word; on the last row every column must BE a word.
function search(words, n, { limit, timeMs }) {
  const prefixes = new Set();
  const byFirst = new Map();
  for (const w of words) {
    for (let k = 0; k <= n; k++) prefixes.add(w.slice(0, k));
    if (!byFirst.has(w[0])) byFirst.set(w[0], []);
    byFirst.get(w[0]).push(w);
  }
  const wordSet = new Set(words);

  const found = [];
  const deadline = Date.now() + timeMs;
  let timedOut = false;
  const rows = [];
  const cols = new Array(n).fill("");

  function place(i) {
    if (timedOut || found.length >= limit) return;
    if (Date.now() > deadline) { timedOut = true; return; }
    if (i === n) { found.push(rows.slice()); return; }

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
  return { found, timedOut };
}

// Favour squares built from words people actually know, and keep the bank
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

const bank = {};
const dict = {};
for (const { n, maxRank, want, timeMs } of SIZES) {
  const words = poolFor(n, maxRank);
  const t0 = Date.now();
  const { found, timedOut } = search(words, n, { limit: LIMIT, timeMs });
  const chosen = pick(found, want, rank);
  if (chosen.length < want) {
    console.warn(`  warning: wanted ${want} ${n}x${n} puzzles, got ${chosen.length}`);
  }
  bank[n] = chosen;
  dict[n] = words;
  console.log(`${n}x${n}: pool ${words.length}, found ${found.length}${timedOut ? " (time-capped)" : ""}, kept ${chosen.length} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("  e.g. " + chosen.slice(0, 3).map((s) => s.join(" ")).join(" | "));
}

// A square whose words aren't in the dictionary could never be validated.
for (const { n } of SIZES) {
  const set = new Set(dict[n]);
  for (const sq of bank[n]) for (const w of sq) {
    if (!set.has(w)) throw new Error(`${n}x${n} word "${w}" is missing from the dictionary`);
  }
}

const flat = (sqs) => sqs.map((s) => s.join("")).join(" ");
const out = path.join(ROOT, "puzzles.js");
fs.writeFileSync(out, `// GENERATED FILE — do not edit by hand.
// Rebuild with: npm run generate   (see tools/generate.mjs)
//
// BANK[n] holds solved n x n double word squares, one per string, rows
// concatenated. WORDS[n] is the dictionary a typed row or column is checked
// against: common English words, names and contraction fragments removed.
window.WORD_SQUARE_DATA = {
  BANK: {
    4: "${flat(bank[4])}".split(" "),
    5: "${flat(bank[5])}".split(" ")
  },
  WORDS: {
    4: "${dict[4].join(" ")}".split(" "),
    5: "${dict[5].join(" ")}".split(" ")
  }
};
`);
console.log(`wrote puzzles.js — ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
