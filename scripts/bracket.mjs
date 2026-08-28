/**
 * Reorders each round so the two ties whose winners meet next sit next to each
 * other, and tags them with the next-round tie they feed.
 *
 * UCL qualifying is re-drawn every round, so there is no fixed bracket to read
 * off the article. The linkage is recovered from the results instead: a tie in
 * round N+1 names two teams, and whichever round-N ties those teams won are its
 * feeders. Rounds are therefore ordered back to front — the last round keeps its
 * source order and each earlier round is permuted to match its successor.
 *
 * Rounds don't halve (Q1 14 ties -> Q2 12) because fresh entrants join each
 * round, so a next-round tie can have 0, 1 or 2 feeders. Ties feeding nothing
 * (both sides eliminated, or the next round is undrawn) keep their relative
 * order at the end of the column.
 */

const nameOf = (team) => (typeof team === "string" ? team : team?.name ?? "");
const isPlaceholder = (team) => typeof team !== "string" && Boolean(team?.placeholder);

/** The side that advanced, if the source recorded one. */
function winnerName(tie) {
  const side = tie.winner === "home" ? tie.home : tie.winner === "away" ? tie.away : null;
  // "Winner of CP match 3" names no club, so it can't link two rounds.
  return side && !isPlaceholder(side) ? nameOf(side) : null;
}

function orderRound(ties, nextTies) {
  if (!nextTies?.length) return ties.map((tie) => ({ ...tie, feeds: null }));

  const byWinner = new Map();
  ties.forEach((tie, i) => {
    const w = winnerName(tie);
    if (w && !byWinner.has(w)) byWinner.set(w, i);
  });

  const ordered = [];
  const used = new Set();

  nextTies.forEach((next, nextIndex) => {
    // Home feeder first, then away, so the pair reads in the same order as the
    // tie it produces.
    for (const side of [next.home, next.away]) {
      const i = byWinner.get(nameOf(side));
      if (i === undefined || used.has(i)) continue;
      used.add(i);
      ordered.push({ ...ties[i], feeds: nextIndex });
    }
  });

  ties.forEach((tie, i) => {
    if (!used.has(i)) ordered.push({ ...tie, feeds: null });
  });

  return ordered;
}

const PATH_OF_LABEL = {
  "champions path": "champions",
  "main path": "main",
  "league path": "league",
};

/**
 * Which path(s) one side of a tie belongs to.
 *   placeholder — the article spells it out: "Winner of CP match 3".
 *   known club  — the path of the tie it won earlier, else how it entered
 *                 (Teams-table CH/MP header, or a transfer out of UCL).
 * No signal means a domestic entrant, which belongs to the default path. That
 * has to be decided per side, not per tie: a fresh play-off entrant paired with
 * a Champions Path drop-out is a genuinely mixed tie, and treating the entrant
 * as silent would file the whole tie under the drop-out's path.
 */
function sidePaths(side, winners, fallback) {
  if (isPlaceholder(side)) {
    if (/\bCP\b/i.test(side.name)) return ["champions"];
    if (/\bMP\b/i.test(side.name)) return ["main"];
    return [fallback];
  }
  const earlier = winners.get(nameOf(side));
  if (earlier) return [...earlier];

  const entry = side.entry;
  if (entry?.path) return [entry.path];
  if (entry?.kind === "transfer") {
    return [/champions/i.test(entry.fromPath ?? "") ? "champions" : "main"];
  }
  return [fallback];
}

/**
 * Splits a single derived bracket into per-path brackets, for competitions whose
 * article labels only some rounds. A tie whose two sides come from different
 * paths (the UEL play-off round merges them) is listed under both and flagged,
 * rather than being filed under one arbitrarily.
 */
export function derivePaths(data, competition) {
  const combined = data.paths.find((p) => p.id === "all");
  if (!combined) return data;

  const assigned = new Map(); // tie -> Set of path ids
  const winners = new Map(); // club name -> path ids of the tie it won

  for (const round of combined.rounds) {
    for (const tie of round.ties) {
      const stated = PATH_OF_LABEL[(tie.group ?? "").toLowerCase()];
      const paths = new Set();

      if (stated) {
        paths.add(stated);
      } else {
        for (const side of [tie.home, tie.away]) {
          for (const p of sidePaths(side, winners, competition.defaultPath)) paths.add(p);
        }
      }

      assigned.set(tie, paths);
      tie.crossPath = paths.size > 1;
      // Tabs already convey the path; only the unusual merged tie needs a badge.
      if (tie.crossPath) tie.group = "Champions + Main Path";
      else delete tie.group;

      const won = tie.winner === "home" ? tie.home : tie.winner === "away" ? tie.away : null;
      if (won && !isPlaceholder(won)) winners.set(nameOf(won), paths);
    }
  }

  const paths = competition.paths
    .map((p) => ({
      id: p.id,
      label: p.label,
      note: p.note,
      rounds: combined.rounds
        .map((r) => ({ ...r, ties: r.ties.filter((t) => assigned.get(t).has(p.id)) }))
        .filter((r) => r.ties.length),
    }))
    .filter((p) => p.rounds.length);

  return { ...data, paths };
}

/** Returns a copy of the payload with every path's rounds ordered. */
export function orderBracket(data) {
  const paths = (data.paths ?? []).map((path) => {
    const rounds = path.rounds.map((r) => ({ ...r, ties: [...r.ties] }));

    // Back to front: each round is arranged against its already-final successor.
    for (let i = rounds.length - 2; i >= 0; i--) {
      rounds[i].ties = orderRound(rounds[i].ties, rounds[i + 1].ties);
    }
    const last = rounds[rounds.length - 1];
    if (last) last.ties = last.ties.map((tie) => ({ ...tie, feeds: null }));

    return { ...path, rounds };
  });

  return { ...data, paths };
}
