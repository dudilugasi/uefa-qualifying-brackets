# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page viewer for UEFA club-competition qualifying brackets (Champions League, Europa League, Conference League), scraped from Wikipedia on demand. Zero dependencies — no build step, no test suite, no linter. Plain ES modules on the Node side, plain DOM on the browser side.

## Commands

```bash
npm start          # server on :8080 — serves the page and exposes POST /api/refresh
npm run dev        # same, with node --watch
npm run refresh    # scrape + rewrite data.json from the CLI, printing a per-round summary
```

Flags: `node scripts/server.mjs --port 3000 --season "2026–27"`, `node scripts/refresh.mjs "2026–27"`.

The season string uses an **en dash** (`2026–27`), because it is interpolated straight into Wikipedia article titles. A hyphen produces a 404 chain and `could not load article`.

The page must be served, not opened as `file://` — `app.js` fetches `data.json`.

## Architecture

Two halves that meet at `data.json`:

**Scrape/derive (`scripts/`, Node)** → writes `data.json`
**Render (`index.html` + `app.js` + `styles.css`, browser)** → reads `data.json`

`data.json` is committed. It is the whole contract between the two halves, and it is also what makes the page work on static hosting (GitHub Pages) where `/api/refresh` doesn't exist — `detectRefreshSupport()` in [app.js](app.js) removes the Refresh button in that case.

### The refresh pipeline

`store.mjs#refresh()` is the one entry point (both `server.mjs` and `refresh.mjs` call it). Order matters:

1. **`sources/wikipedia.mjs#load()`** per competition — fetch the qualifying article, `parse()` its `wikitable sports-series` tables into rounds/ties, then fetch the *season* article's Teams table for each club's entry route (`interpretEntry`). Competitions are fetched **sequentially with a 350 ms gap**; parallel fetches earned HTTP 429.
2. **`bracket.mjs#derivePaths()`** — only for competitions with `derivePaths: true` (UEL), whose article labels just one round. Infers each tie's path from its sides' provenance, which is why it must run after step 1's entry data is attached.
3. **`references.mjs#resolveReferences()`** — runs across *all* competitions at once, because a placeholder can point into another one ("Loser of EL CP match 6"). Rewrites `"Winner of CP match 3"` into either the real club (feeder decided) or a readable label + `ref.tieKey` (feeder pending).
4. **`bracket.mjs#orderBracket()`** — permutes each round so feeder ties sit next to each other. Qualifying is re-drawn every round, so there is no bracket structure in the source; linkage is recovered from results, working **back to front** (last round keeps source order, each earlier round is arranged against its successor). Rounds don't halve — fresh entrants join each round — so a tie may have 0, 1 or 2 feeders.
5. Atomic write via temp file + `rename`.

### Degradation rules (deliberate, don't "simplify" them away)

- A competition whose fetch fails keeps its **previous** bracket, flagged `stale: true`; `data.json` is only rewritten if at least one competition loaded.
- A failed *entries* lookup never fails the refresh. `carryEntries()` copies routes from the previous payload by club name, and the shortfall is reported through `entryWarnings` → the page's banner.
- `wikipedia.mjs` throws loudly on structural surprises rather than returning a half bracket. The scraper's assumptions about article markup are documented in its header comment — read it before touching the regexes.
- macOS TLS fallback: Node ignores the keychain, so behind a TLS-intercepting proxy the first `fetch` fails with an unknown-issuer error; `request()` retries with the system roots read via `security find-certificate`. It *adds* trust anchors, it never disables verification.

### Adding a competition

Push an entry onto `COMPETITIONS` in [competitions.mjs](scripts/competitions.mjs). The important axis is how the source article labels paths:

- `splitPaths: true` — the article has divider rows per path in every split round (UCL, UECL); the parser buckets ties per path directly.
- `derivePaths: true` — only some rounds are labelled (UEL); the parser emits one `"all"` bucket and `derivePaths()` splits it, flagging genuinely mixed ties as `crossPath` and listing them under both paths.

`qualifyingArticles` is a list because Wikipedia renames these articles between seasons; each candidate is tried until one yields tie tables.

### Rendering

[app.js](app.js) is procedural and re-renders whole subtrees with `replaceChildren`. Two tab rows: competition tabs (exclusive) and path tabs (**filters, not an exclusive set** — nothing selected shows a synthetic combined "All" path built by `buildAllPath()`, clicking the active path clears back to it). `selection` survives refreshes so the view doesn't jump.

Two layouts, switched from the header and held in memory only (`layout`, default `"columns"`):

- **columns** — one column per round, every tie stacked.
- **sub** — one small bracket per tie nothing feeds out of, plus everything feeding it, wrapped across the page. Deep rounds (UECL main path Q2 is 43 ties) otherwise become one endless column. `successors()` re-derives the linkage from results rather than reading `tie.feeds`, because `buildAllPath()` namespaces `feeds` per path (`"champions:3"`) and indexes that path's round, not the merged one.

Wires are an SVG overlay drawn in absolute coordinates from `getBoundingClientRect()`, so `drawWires()` must be re-run on resize, on font load, and after any re-render. They are plain strokes — no arrowheads — and stay behind the cards in both states; a traced wire changes colour and gains a glow but keeps its weight.

Hover/tap on a team row traces its route (`data-team` matching across rounds) and fills the entry bar across the foot of the window; a click pins it, and while pinned hover is inert. The bar is pointer-transparent until shown, and the `pointerleave` handlers on the bracket and the bar exempt each other so moving between them doesn't clear the route.

`resyncTrace()` runs after every `renderPath()`: a marked route means something different once the view changes, so the pinned card is rebuilt from the row now on screen (the same club carries different entry data per competition), or dropped if that club isn't in the new view. A club that dropped in from another competition has no domestic entry of its own here — `originEntry()` reads it off the competition it fell out of, and the drop-in line links across via `showInCompetition()`.
