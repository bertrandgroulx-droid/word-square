# 🔡 Word Square

**A phone-first daily word puzzle. Fill the grid so every row and every column
spells a word.**

Word Square is a static, dependency-free web game built for a phone in portrait.
The whole game fits on one screen: the grid, a tray holding exactly the letters
you still need, and four buttons. No accounts, no network calls, no build step.

```
G R A B     across: GRAB ROPE OPEN WEST
R O P E     down:   GROW ROPE APES BENT
O P E N
W E S T     The grid starts with a few of those letters filled in.
            The tray holds the rest — no spares, no shortage.
```

Mirrored grids, where each column repeats its row, are far easier: solve a row
and you have a column. Rather than throw them away, the game uses them as the
Easy setting and says so in the rules. Hard grids have no row in common with any
column.

## The puzzle

Each grid is a **double word square**: every row is a word and every column is a
word, and the two sets don't have to match. They're markedly harder to find than
the classic symmetric square, which is why the bank is generated offline rather
than at runtime.

- **Two difficulties, and the difference is real.** *Easy* grids are mirrored:
  column *k* spells the same word as row *k*, so a solved row hands you a column
  for free. *Hard* grids are strict, with no row matching any column — eight
  separate words at 4×4, ten at 5×5, and no reflection to lean on.
- **Two sizes.** 4×4 opens with 6 letters given and 10 in the tray; 5×5 opens
  with 9 given and 16 in the tray. Every row and column is guaranteed at least
  one given letter, so no line is pure guesswork.
- **A puzzle a day for each of the four combinations**, chosen by your local
  calendar date, so the grid turns over at your midnight and everyone gets the
  same one.
- **Any valid square wins**, not just the stored solution. Rows and columns are
  checked against a dictionary, so a different arrangement that works still
  counts.
- **200 puzzles per bank**, 800 in total, plus 🎲 for a random practice grid at
  any time.

## Playing

| Action | How |
|---|---|
| Select a square | Tap it |
| Place a letter | Tap a tray tile, or type it on a keyboard |
| Take a letter back | Tap the placed letter, or press Backspace |
| Switch across / down | Tap the selected square again, or press Space |
| Move around | Arrow keys |

💡 fills in one correct letter and counts against you. 🔀 reshuffles the tray.
↩️ empties the grid. 🎲 deals a practice puzzle, and the label at the top brings
you back to today's.

Your progress, timer, hint count and daily streak are kept in `localStorage`, so
a reload or a closed tab picks up where you left off. Nothing leaves the device.

## Run it locally

Static files, but the game uses `localStorage`, so serve it rather than opening
`index.html` off the filesystem:

```sh
npm run serve
# then visit http://localhost:8000
```

## How the puzzles are made

`puzzles.js` is generated, and `tools/generate.mjs` rebuilds it:

```sh
npm run generate    # needs network; caches its downloads in .cache/
```

It fetches four word lists and combines them into a pool:

| Source | Used for |
|---|---|
| [TWL Scrabble dictionary](https://github.com/redbo/scrabble) | What a typed row is **accepted** against. Scrabble lists carry no proper nouns, so `MOORE` can't sneak in |
| [OpenSubtitles frequency list](https://github.com/hermitdave/FrequencyWords) | Which of those the puzzles are **built** from |
| [LDNOOBW](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words) | Profanity, filtered out |

Those are two different questions and the generator answers them separately.

A row or column you type is checked against **the whole Scrabble dictionary at
that length** — 3,976 four-letter words and 8,875 five-letter ones. If a board
would take it, the grid takes it, `QOPH` and `ZARF` included.

The squares themselves are built from a far smaller pool of **common** words,
1,216 at 4×4 and up to 2,911 at 5×5. A bank generated over the whole Scrabble
list would cheerfully deal a grid spelling `QOPH` and `XYST`, which is
unsolvable rather than hard. So what you are dealt stays ordinary and only the
accept-check is wide, which is what makes "any valid square wins" mean
something.

The search then fills a grid row by row, pruning on column prefixes: after *i*
rows, every column holds an *i*-letter prefix that must still be extendable to a
word, and on the last row every column has to *be* one. Finished grids are kept
only if they match the shape their bank wants, mirrored or strict. Candidates
are ranked so the least common word in a grid is as common as possible, and each
bank keeps only squares sharing at most one word with any other.

Strict grids are much rarer than mirrored ones, so the hard 5×5 search reaches
further down the frequency list to find enough of them. That is the one place
where difficulty costs you some vocabulary familiarity as well as symmetry.

A short hand-written exclusion list at the top of the generator catches the
stragglers — words that pass every automatic filter but still read as a proper
noun or as something you'd rather not stare at. Re-check it if you change the
sources.

There is deliberately **no first-names filter**. An early version had one and it
threw hundreds of ordinary words out of the dictionary, `WILL` `ROSE` `GRACE`
`HOPE` `DAWN` `JACK` among them, so a player who wrote one across a row was told
it wasn't a word. It was redundant as well as harmful: a Scrabble dictionary
holds no proper nouns, so `HELEN` and `SANTA` are already absent while `WILL`
and `ROSE` are correctly present. The test pins both directions.

`KEEP_BANK=1 npm run generate` rebuilds the dictionary and leaves the puzzles
exactly as they are, which is how that fix shipped: widening the dictionary is
something every player wants immediately, while new puzzles would change today's
daily under anyone half way through solving it.

The icons are generated too, by `tools/make-icons.mjs`, which writes the PNGs
and the `.ico` byte by byte rather than pulling in an image library.

The icon set is deliberately broad. Every GitHub Pages project under one account
shares a single origin, and browsers tend to cache one bookmark icon per origin,
so an app that declares only an SVG can end up wearing a neighbouring app's
icon. Declaring the PNG and `.ico` forms Safari actually reads makes that less
likely. It cannot rule it out: the only complete fix is giving each app its own
domain.

## Testing

A headless smoke test (Playwright) serves the folder and verifies all 800 stored
squares: that each really is a double word square, and that each has the shape
its difficulty promises. It then plays a game: placing, taking back, hinting,
solving, switching size and difficulty, reloading, and returning to the daily
puzzle.

```sh
npm install
npx playwright install chromium   # once
npm test
```

It also runs in CI on every push and PR (`.github/workflows/ci.yml`).

## Deploying with GitHub Pages

`.github/workflows/pages.yml` deploys the site on every push to `main`. Set
**Settings → Pages → Build and deployment → Source** to **GitHub Actions** once,
and the game is served at `https://<your-username>.github.io/word-square/`.

## Add to Home Screen

The app ships `apple-touch-icon` images at every iPhone and iPad size plus a web
manifest, so on iOS (Share → *Add to Home Screen*) it gets a crisp icon and
launches full-screen. Installable on Android too.
