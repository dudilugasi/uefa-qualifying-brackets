/**
 * Turns opaque placeholder slots into something readable.
 *
 * A drawn-but-unplayed round lists entrants as "Winner of MP match 1", which
 * says nothing about which fixture that is. Every tie carries a pathId and a
 * matchNumber, so the referenced tie can be looked up and the slot relabelled
 * "Winner of Hradec Králové v Beşiktaş" — or replaced by the actual club once
 * that tie has been decided.
 *
 * References may cross competitions ("Loser of EL CP match 6"), so this runs
 * over all competitions together, after each has been parsed.
 */

import { parseReference, ROUND_ORDER } from "./competitions.mjs";

const shortName = (team) => (typeof team === "string" ? team : team?.name ?? "?");

/** Index every tie by competition, path and match number. */
function indexTies(competitions) {
  const index = new Map(); // `${compId}|${pathId}|${matchNumber}` -> [{tie, round}]
  for (const competition of competitions) {
    for (const path of competition.paths) {
      for (const round of path.rounds) {
        for (const tie of round.ties) {
          if (tie.matchNumber == null) continue;
          const key = `${competition.id}|${tie.pathId ?? path.id}|${tie.matchNumber}`;
          if (!index.has(key)) index.set(key, []);
          const bucket = index.get(key);
          // The same tie object can sit in two paths (a cross-path play-off).
          if (!bucket.some((e) => e.tie === tie)) bucket.push({ tie, round: round.name });
        }
      }
    }
  }
  return index;
}

/**
 * Pick which tie a reference means. Candidates share a competition, path and
 * match number but may sit in different rounds; the convention is that a slot
 * refers to the round immediately before it, so prefer that, then fall back to
 * a unique candidate. Anything still ambiguous is left unresolved on purpose.
 */
function pickCandidate(candidates, fromRound) {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];

  const fromIdx = ROUND_ORDER.indexOf(fromRound);
  const previous = candidates.find(
    (c) => ROUND_ORDER.indexOf(c.round) === fromIdx - 1
  );
  return previous ?? null;
}

function decided(tie) {
  if (tie.winner === "home") return { winner: tie.home, loser: tie.away };
  if (tie.winner === "away") return { winner: tie.away, loser: tie.home };
  return null;
}

export function resolveReferences(competitions) {
  const index = indexTies(competitions);
  const stats = { resolved: 0, labelled: 0, unresolved: 0 };

  for (const competition of competitions) {
    for (const path of competition.paths) {
      for (const round of path.rounds) {
        for (const tie of round.ties) {
          for (const side of ["home", "away"]) {
            const team = tie[side];
            if (!team?.placeholder || team.ref) continue; // already handled

            const ref = parseReference(team.name);
            if (!ref) {
              stats.unresolved++;
              continue;
            }

            const targetComp = ref.competition ?? competition.id;
            const targetPath = ref.path ?? tie.pathId ?? path.id;
            const found = pickCandidate(
              index.get(`${targetComp}|${targetPath}|${ref.matchNumber}`),
              round.name
            );

            if (!found) {
              stats.unresolved++;
              continue;
            }

            const fixture = `${shortName(found.tie.home)} v ${shortName(found.tie.away)}`;
            const outcome = decided(found.tie);

            if (outcome) {
              // The feeder is settled, so name the actual club and keep a note
              // of where it came from.
              const actual = ref.kind === "winner" ? outcome.winner : outcome.loser;
              tie[side] = { ...actual, via: { fixture, kind: ref.kind } };
              stats.resolved++;
            } else {
              team.ref = {
                ...ref,
                fixture,
                round: found.round,
                competition: targetComp,
                tieKey: found.tie.key, // lets the UI draw an arrow from that tie
              };
              team.label = `${ref.kind === "winner" ? "Winner" : "Loser"} of ${fixture}`;
              stats.labelled++;
            }
          }
        }
      }
    }
  }

  return stats;
}
