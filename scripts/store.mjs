/** Fetch every competition and persist data.json. Shared by server.mjs and refresh.mjs. */

import { writeFile, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "./sources/wikipedia.mjs";
import { orderBracket, derivePaths } from "./bracket.mjs";
import { COMPETITIONS } from "./competitions.mjs";
import { resolveReferences } from "./references.mjs";

/** Web root — the project directory, one level up from scripts/. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DATA_FILE = join(ROOT, "data.json");

/** Temp file + rename, so a crash mid-write can't truncate data.json. */
async function writeData(data) {
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await rename(tmp, DATA_FILE);
}

/** The payload minus the one field that changes on every single run. */
function withoutTimestamp(payload) {
  const { fetchedAt, ...rest } = payload;
  return JSON.stringify(rest);
}

async function previous() {
  try {
    return JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch {
    return null;
  }
}

const eachTeam = function* (competition) {
  for (const path of competition?.paths ?? []) {
    for (const round of path.rounds) {
      for (const tie of round.ties) yield tie.home, yield tie.away;
    }
  }
};

/** Copy entry routes from a previous payload by club name. */
function carryEntries(competition, previousCompetition) {
  if (!previousCompetition) return 0;

  const known = new Map();
  for (const team of eachTeam(previousCompetition)) {
    if (team?.entry && team.name) known.set(team.name, team.entry);
  }

  let carried = 0;
  for (const team of eachTeam(competition)) {
    if (!team || team.entry || team.placeholder || team.bye) continue;
    const entry = known.get(team.name);
    if (entry) {
      team.entry = entry;
      carried++;
    }
  }
  return carried;
}

export async function refresh(season) {
  const old = await previous();

  // Sequential, with a short gap: three competitions in parallel meant six
  // concurrent article fetches, which is what earned a 429 from Wikipedia.
  const results = [];
  for (const c of COMPETITIONS) {
    if (results.length) await new Promise((r) => setTimeout(r, 350));
    try {
      const raw = await load(season, c);
      // derivePaths needs the entry data load() attaches, so it runs after.
      results.push({ status: "fulfilled", value: c.derivePaths ? derivePaths(raw, c) : raw });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }
  }

  const competitions = [];
  const errors = [];

  results.forEach((r, i) => {
    const c = COMPETITIONS[i];
    if (r.status === "fulfilled") {
      competitions.push(r.value);
      return;
    }
    errors.push({ competition: c.id, error: r.reason?.message ?? String(r.reason) });
    // Keep the last good bracket for this competition rather than dropping it.
    const stale = old?.competitions?.find((x) => x.id === c.id);
    if (stale) competitions.push({ ...stale, stale: true });
  });

  if (!competitions.length) {
    throw new Error(errors.map((e) => `${e.competition}: ${e.error}`).join("; "));
  }

  // If only the entry lookup failed, reuse the previous run's routes instead of
  // showing "route unknown" on every club.
  const entryWarnings = [];
  for (const c of competitions) {
    if (!c.source.entries?.error) continue;
    const previousCompetition = old?.competitions?.find((x) => x.id === c.id);
    // The league-phase entrants come from the same article, so they are missing
    // for the same reason; the previous run's list is better than none.
    if (!c.leaguePhase && previousCompetition?.leaguePhase) {
      c.leaguePhase = previousCompetition.leaguePhase;
    }
    const carried = carryEntries(c, previousCompetition);
    entryWarnings.push({
      competition: c.id,
      error: c.source.entries.error,
      carriedOver: carried,
    });
  }

  // Placeholder slots can reference another competition, so resolve across all
  // of them before ordering — a resolved slot names a real club, which lets the
  // ordering pass link it to the next round.
  const refs = resolveReferences(competitions);
  const ordered = competitions.map((c) => (c.stale ? c : orderBracket(c)));

  const data = {
    season,
    fetchedAt: new Date().toISOString(),
    references: refs,
    competitions: ordered,
    ...(errors.length ? { errors } : {}),
    ...(entryWarnings.length ? { entryWarnings } : {}),
  };

  // A scrape that found nothing new leaves the file alone, timestamp included:
  // otherwise every run rewrites data.json and reads as a change to git.
  if (old && withoutTimestamp(old) === withoutTimestamp(data)) return old;

  await writeData(data);
  return data;
}
