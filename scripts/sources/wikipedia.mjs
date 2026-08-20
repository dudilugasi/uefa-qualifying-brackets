/**
 * Scrapes the UCL qualifying Wikipedia article into the shape index.html renders.
 * Wikipedia is the only free, key-less source that covers qualifying rounds
 * (football-data.org's free tier starts at the league phase).
 *
 * Article shape this relies on: one `wikitable sports-series` per round whose
 * <caption> names the round, columns Team 1 | Agg. | Team 2 | 1st leg | 2nd leg,
 * a full-width divider row naming each path, and <strong> on the winning team.
 * Brittle by nature — load() throws loudly rather than return half a bracket.
 */

import { get as httpsGet } from "node:https";
import { execFile } from "node:child_process";
import { lookup } from "../countries.mjs";
import {
  ROUND_ORDER,
  PLACEHOLDER_RE,
  interpretEntry,
} from "../competitions.mjs";

const API = "https://en.wikipedia.org/w/api.php";

const KEYCHAINS = [
  "/Library/Keychains/System.keychain",
  "/System/Library/Keychains/SystemRootCertificates.keychain",
];

const isTlsTrustError = (code) => /CERT|SELF_SIGNED|ISSUER/i.test(code ?? "");

/**
 * Node ignores the macOS keychain, so a TLS-intercepting corporate proxy makes
 * every request fail with an unknown issuer. Read the system roots (which
 * include the proxy's CA) so requests can be retried against real trust anchors
 * — this adds certificates the OS already trusts, it does not skip verification.
 */
let caPromise;
function systemCa() {
  if (caPromise) return caPromise;
  caPromise = (async () => {
    if (process.platform !== "darwin") return null;
    const chunks = await Promise.all(
      KEYCHAINS.map(
        (kc) =>
          new Promise((resolve) => {
            execFile(
              "security",
              ["find-certificate", "-a", "-p", kc],
              { maxBuffer: 32 * 1024 * 1024 },
              (err, stdout) => resolve(err ? "" : stdout)
            );
          })
      )
    );
    const pem = chunks.join("\n");
    if (!pem.includes("BEGIN CERTIFICATE")) return null;
    return pem
      .split(/(?=-----BEGIN CERTIFICATE-----)/)
      .filter((c) => c.includes("BEGIN CERTIFICATE"));
  })();
  return caPromise;
}

function getWithCa(url, ca) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      url,
      { ca, headers: { "user-agent": "ucl-bracket/1.0 (local dev tool)" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            retryAfter: res.headers["retry-after"],
            body,
          })
        );
      }
    );
    req.on("error", (e) => reject(new Error(`network error: ${e.code ?? e.message}`)));
    req.setTimeout(20000, () => req.destroy(new Error("request timed out")));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One GET, transparently retrying through the TLS fallback if needed. */
async function request(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "ucl-bracket/1.0 (local dev tool)" },
    });
    return {
      status: res.status,
      statusText: res.statusText,
      retryAfter: res.headers.get("retry-after"),
      body: await res.text(),
    };
  } catch (e) {
    const code = e.cause?.code ?? e.code;
    if (!isTlsTrustError(code)) {
      throw e instanceof Error && !code ? e : new Error(`network error: ${code ?? e.message}`);
    }
    const ca = await systemCa();
    if (!ca) {
      throw new Error(
        `TLS trust error (${code}) and no system CA bundle available — ` +
          `set NODE_EXTRA_CA_CERTS to a PEM containing your proxy's root CA.`
      );
    }
    return getWithCa(url, ca); // retry against the OS trust store
  }
}

/** The article has been renamed between seasons; try each known form. */
export const candidateTitles = (season, competition) =>
  competition.qualifyingArticles(season);

const MAX_ATTEMPTS = 4;

async function fetchParsed(title, attempt = 1) {
  const url = `${API}?action=parse&page=${encodeURIComponent(
    title
  )}&prop=text&redirects=1&formatversion=2&format=json&origin=*`;

  const res = await request(url);

  // Wikipedia rate-limits bursts. Back off and retry rather than degrading
  // silently — a dropped entries fetch used to surface as "route unknown".
  if (res.status === 429 || res.status === 503) {
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`Wikipedia API ${res.status} after ${attempt} attempts`);
    }
    const hinted = Number(res.retryAfter) * 1000;
    const wait = Math.min(Number.isFinite(hinted) && hinted > 0 ? hinted : 600 * 2 ** attempt, 8000);
    await sleep(wait);
    return fetchParsed(title, attempt + 1);
  }
  if (res.status !== 200) {
    throw new Error(`Wikipedia API ${res.status} ${res.statusText}`);
  }

  const json = JSON.parse(res.body);
  if (json.error) throw new Error(`Wikipedia API: ${json.error.info}`);
  const html = json?.parse?.text;
  if (!html) throw new Error("Wikipedia API returned no parsed text");
  return { html, title: json.parse.title ?? title };
}

/** Section of rendered HTML under an h2, up to the next h2. */
function sectionAfter(html, headingText) {
  const heads = [...html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const i = heads.findIndex((h) =>
    cellText(h[2]).toLowerCase().startsWith(headingText.toLowerCase())
  );
  if (i < 0) return null;
  const end = heads.slice(i + 1).find((h) => h[1] === "2")?.index ?? html.length;
  return html.slice(heads[i].index, end);
}

/**
 * The main season article's Teams table gives each club's finishing position,
 * as "Aston Villa (4th)", grouped by entry round and path (CH / LP). The
 * qualifying article only carries coefficients, so entry info comes from here.
 */
const PATH_IDS = { CH: "champions", LP: "league", MP: "main" };

/** Each club cell of the Teams table, with the round and path headers in force. */
function* teamsTableCells(html) {
  const section = sectionAfter(html, "Teams");
  if (!section) throw new Error("no Teams section in season article");

  // Positions render inside markup — "(<abbr>1st</abbr>)" — so match on text.
  const table = [...section.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)]
    .map((m) => m[0])
    .find((t) => /\((?:1st|2nd|3rd|\d+th|CW|CON)\)/i.test(cellText(t)));
  if (!table) throw new Error("no positions table in Teams section");

  let round = null;
  let path = null;

  for (const row of rowsOf(table)) {
    const cells = cellsOf(row);
    let i = 0;
    while (i < cells.length && cells[i].header) {
      const text = cells[i].text;
      if (text) {
        // CH / LP / MP are path headers; anything else names the entry round.
        if (/^(CH|LP|MP)$/i.test(text)) path = text.toUpperCase();
        else {
          round = text;
          path = null; // a new round resets the path until its own header appears
        }
      }
      i++;
    }
    for (; i < cells.length; i++) {
      const m = cells[i].text.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      if (!m) continue;
      // An empty name is a slot the draw hasn't filled: "(CL CH PO)".
      yield { name: m[1].trim(), token: m[2].trim(), round, path, html: cells[i].html };
    }
  }
}

export function parseEntries(html) {
  const entries = new Map();

  for (const cell of teamsTableCells(html)) {
    if (!cell.name) continue;
    entries.set(cell.name, {
      token: cell.token,
      ...interpretEntry(cell.token),
      entryRound: cell.round,
      path: PATH_IDS[cell.path] ?? null,
    });
  }

  if (!entries.size) throw new Error("Teams table held no positions");
  return entries;
}

/**
 * Clubs the article lists as entering at the league phase, plus the slots there
 * still waiting on another competition ("(EL PO)"). Qualifying has no table for
 * this round, so it is the one part of the bracket that has to come from here;
 * the play-off winners that fill the rest are derived from the ties themselves.
 */
export function parseLeaguePhase(html) {
  const slots = [];

  for (const cell of teamsTableCells(html)) {
    if (!/^league phase/i.test(cell.round ?? "")) continue;

    const country = flagCountry(cell.html);
    const { code, flag } = lookup(country);
    slots.push({
      ...(cell.name ? { name: cell.name } : { placeholder: true }),
      entry: {
        token: cell.token,
        ...interpretEntry(cell.token),
        entryRound: cell.round,
        path: PATH_IDS[cell.path] ?? null,
      },
      ...(country ? { country } : {}),
      ...(code ? { code } : {}),
      ...(flag ? { flag } : {}),
    });
  }

  return slots;
}

export async function fetchArticleHtml(season, competition) {
  const errors = [];
  for (const title of candidateTitles(season, competition)) {
    try {
      const found = await fetchParsed(title);
      if (tieTables(found.html).length) return found;
      errors.push(`${title}: no tie tables`);
    } catch (e) {
      errors.push(`${title}: ${e.message}`);
    }
  }
  throw new Error(`could not load article — ${errors.join("; ")}`);
}

const stripTags = (s) => s.replace(/<[^>]*>/g, "");

function decode(s) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—",
  };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function cellText(html) {
  return decode(
    stripTags(
      html
        .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "") // footnote markers
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<span class="sr-only">[\s\S]*?<\/span>/gi, "")
        .replace(/<br\s*\/?>/gi, " ")
    )
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Country comes from the flag icon's alt text, e.g. alt="Lithuania". */
function flagCountry(html) {
  const m = html.match(/<img[^>]*\balt="([^"]+)"/i);
  const alt = m ? decode(m[1]).trim() : "";
  return alt && !/^(flag|logo)\b/i.test(alt) ? alt : null;
}

/** "3–2", "1–1 (a.e.t.)", "2–2 (10–11 p)" -> { goals:[3,2], extra:"..." } */
function parseScore(text) {
  if (!text) return null;
  const m = text.match(/(\d+)\s*[–\-−]\s*(\d+)/);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length).trim();
  return { goals: [+m[1], +m[2]], extra: rest || null };
}

/** Shootout score, written after the aggregate as "(10–11 p)". */
function parsePens(text) {
  if (!text) return null;
  const m = text.match(/\(\s*(\d+)\s*[–\-−]\s*(\d+)\s*(?:p|pens?|penalties)\b/i);
  return m ? [+m[1], +m[2]] : null;
}

function tieTables(html) {
  return [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)]
    .map((m) => m[0])
    .filter((t) => /<th[^>]*>[\s\S]{0,200}?Agg/i.test(t) && /Team 1/i.test(t));
}

const rowsOf = (table) =>
  [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);

const cellsOf = (row) =>
  [...row.matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi)].map((m) => ({
    header: m[1].toLowerCase() === "h",
    colspan: /\bcolspan\s*=/i.test(m[2]),
    html: m[3],
    text: cellText(m[3]),
    strong: /<(?:b|strong)\b/i.test(m[3]),
  }));

function team(cell) {
  const out = { name: cell.text };

  // A bye: the article puts "N/A" where there is no opponent.
  if (/^(N\/A|bye)$/i.test(cell.text)) {
    out.bye = true;
    return out;
  }

  // "Winner of CP match 3" — a drawn slot whose feeder tie is unplayed. It is
  // not a club, so it gets no flag and no qualification lookup.
  if (PLACEHOLDER_RE.test(cell.text)) {
    out.placeholder = true;
    return out;
  }

  const countryName = flagCountry(cell.html);
  const { code, flag } = lookup(countryName);
  if (countryName) out.country = countryName;
  if (code) out.code = code;
  if (flag) out.flag = flag;
  return out;
}

function parseTieRow(cells) {
  // Team 1 | Agg. | Team 2 | 1st leg | 2nd leg
  if (cells.length < 3) return null;
  const home = team(cells[0]);
  const away = team(cells[2]);
  if (!home.name || !away.name) return null;

  const aggCell = cells[1];
  const agg = parseScore(aggCell.text);
  const leg1 = parseScore(cells[3]?.text);
  const leg2 = parseScore(cells[4]?.text);

  const legs = [];
  if (leg1) legs.push(leg1.goals);
  if (leg2) legs.push(leg2.goals);

  const pens = parsePens(aggCell.text);
  const tie = { home, away, legs };
  if (agg) tie.agg = agg.goals;
  if (pens) tie.pens = pens;

  // The article bolds the advancing side — more reliable than re-deriving it.
  if (cells[0].strong && !cells[2].strong) tie.winner = "home";
  else if (cells[2].strong && !cells[0].strong) tie.winner = "away";

  const notes = [];
  if (agg) notes.push(`${agg.goals[0]}–${agg.goals[1]} agg.`);
  if (pens) notes.push(`${pens[0]}–${pens[1]} on pens`);
  for (const extra of [leg1?.extra, leg2?.extra, agg?.extra]) {
    if (!extra) continue;
    const clean = extra.replace(/^[(\s]+|[)\s]+$/g, "");
    if (clean && !/^\d+\s*[–\-−]\s*\d+\s*(p|pens?|penalties)$/i.test(clean)) {
      notes.push(clean);
    }
  }
  if (agg && legs.length === 2) {
    const summed = legs.reduce((a, [h, x]) => [a[0] + h, a[1] + x], [0, 0]);
    // Mismatch means the article annotated the tie (walkover, reversed legs,
    // forfeit). Keep the printed aggregate and flag it rather than guess.
    if (summed[0] !== agg.goals[0] || summed[1] !== agg.goals[1]) {
      notes.push("legs do not sum to printed aggregate — see article notes");
    }
  }
  if (notes.length) tie.note = [...new Set(notes)].join(" · ");
  return tie;
}

export function parse(html, season, competition, resolvedTitle) {
  const tables = tieTables(html);
  if (!tables.length) throw new Error("no tie tables found in article");

  // bucket id -> round name -> ties. One bucket per path when the competition
  // splits cleanly, otherwise a single bucket holding the whole bracket.
  const buckets = new Map(
    (competition.splitPaths ? competition.paths.map((p) => p.id) : ["all"]).map(
      (id) => [id, new Map()]
    )
  );
  let tieCount = 0;

  for (const table of tables) {
    const caption = cellText(
      table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? ""
    );
    const round = ROUND_ORDER.find((r) =>
      caption.toLowerCase().includes(r.toLowerCase())
    );
    if (!round) continue;

    // Rounds with no divider row belong to the competition's default path.
    let path = competition.paths.find((p) => p.id === competition.defaultPath);
    let sawDivider = false;
    // Matches are numbered per path group within a round, which is what the
    // "Winner of CP match 3" references point at.
    const groupCounts = new Map();

    for (const row of rowsOf(table)) {
      const cells = cellsOf(row);
      if (!cells.length) continue;

      if (cells.length === 1 && cells[0].colspan) {
        const hit = competition.paths.find((p) =>
          cells[0].text.toLowerCase().includes(p.label.toLowerCase())
        );
        if (hit) {
          path = hit;
          sawDivider = true;
        }
        continue;
      }
      if (cells.every((c) => c.header)) continue;

      const tie = parseTieRow(cells);
      if (!tie) continue;

      // Record the stated path so derivePaths can trust it over inference.
      if (sawDivider && !competition.splitPaths) tie.group = path.label;
      tie.pathId = path.id;

      const seq = (groupCounts.get(path.id) ?? 0) + 1;
      groupCounts.set(path.id, seq);
      // Undecided ties print "Match 7" where the aggregate goes; trust that
      // over the row count when present.
      const stated = cells[1]?.text.match(/^match\s+(\d+)$/i);
      tie.matchNumber = stated ? Number(stated[1]) : seq;
      // Stable handle so a TBD slot can point back at the tie that feeds it.
      tie.key = `${competition.id}|${path.id}|${round}|${tie.matchNumber}`;

      const bucketId = competition.splitPaths ? path.id : "all";
      const rounds = buckets.get(bucketId);
      if (!rounds.has(round)) rounds.set(round, []);
      rounds.get(round).push(tie);
      tieCount++;
    }
  }

  if (!tieCount) throw new Error("tie tables found but no rows parsed");

  const roundsOfBucket = (id) =>
    ROUND_ORDER.filter((r) => buckets.get(id).has(r)).map((r) => ({
      name: r,
      ties: buckets.get(id).get(r),
    }));

  const paths = competition.splitPaths
    ? competition.paths
        .map((p) => ({ id: p.id, label: p.label, note: p.note, rounds: roundsOfBucket(p.id) }))
        .filter((p) => p.rounds.length)
    : [
        {
          id: "all",
          label: "Qualifying",
          note: competition.singleNote,
          rounds: roundsOfBucket("all"),
        },
      ];

  return {
    id: competition.id,
    label: competition.label,
    short: competition.short,
    season,
    source: {
      name: "Wikipedia",
      article: resolvedTitle,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
        resolvedTitle.replace(/ /g, "_")
      )}`,
      tieCount,
    },
    paths,
  };
}

const loose = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Club names differ slightly between articles ("PSV" vs "PSV Eindhoven"). */
function entryMatcher(entries) {
  const byLoose = new Map();
  for (const [name, entry] of entries) byLoose.set(loose(name), entry);

  return (name) => {
    if (entries.has(name)) return entries.get(name);
    const key = loose(name);
    if (byLoose.has(key)) return byLoose.get(key);
    if (key.length < 4) return null;
    for (const [candidate, entry] of byLoose) {
      if (candidate.length < 4) continue;
      if (candidate.startsWith(key) || key.startsWith(candidate)) return entry;
    }
    return null;
  };
}

export async function load(season, competition) {
  const { html, title } = await fetchArticleHtml(season, competition);
  const data = parse(html, season, competition, title);

  // Entry positions are a nice-to-have: never fail a refresh over them.
  try {
    const { html: seasonHtml } = await fetchParsed(competition.seasonArticle(season));
    const match = entryMatcher(parseEntries(seasonHtml));
    data.leaguePhase = { name: "League phase", entrants: parseLeaguePhase(seasonHtml) };
    const missing = [];
    let matched = 0;
    let placeholders = 0;

    for (const path of data.paths) {
      for (const round of path.rounds) {
        for (const tie of round.ties) {
          for (const side of ["home", "away"]) {
            const team = tie[side];
            if (team.placeholder || team.bye) {
              placeholders++;
              continue;
            }
            const entry = match(team.name);
            if (entry) {
              team.entry = entry;
              matched++;
            } else {
              missing.push(team.name);
            }
          }
        }
      }
    }
    data.source.entries = { matched, placeholders, missing: [...new Set(missing)] };
  } catch (e) {
    data.source.entries = { error: e.message };
  }

  return data;
}
