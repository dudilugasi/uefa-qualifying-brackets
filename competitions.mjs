/**
 * Per-competition article naming and bracket shape.
 *
 * The two competitions are structured differently on Wikipedia:
 *   UCL — every round after Q1 is split by a divider row into Champions Path and
 *         League Path, so the two paths are genuinely separate brackets.
 *   UEL — only the third qualifying round is split; Q1, Q2 and the play-off round
 *         are unlabelled and mix entrants from both paths. Splitting it into path
 *         tabs would misfile most rounds, so it renders as one bracket and the
 *         divider label is kept as a per-tie group badge instead.
 */

export const COMPETITIONS = [
  {
    id: "ucl",
    label: "Champions League",
    short: "UCL",
    seasonArticle: (s) => `${s} UEFA Champions League`,
    qualifyingArticles: (s) => [
      `${s} UEFA Champions League qualifying`,
      `${s} UEFA Champions League qualifying phase and play-off round`,
    ],
    splitPaths: true,
    paths: [
      {
        id: "champions",
        label: "Champions Path",
        note: "For domestic league champions. Play-off winners enter the league phase; losers drop into the Europa League league phase.",
      },
      {
        id: "league",
        label: "League Path",
        note: "For non-champions from the higher-ranked associations. Enters at the second qualifying round.",
      },
    ],
    defaultPath: "champions",
  },
  {
    id: "uel",
    label: "Europa League",
    short: "UEL",
    seasonArticle: (s) => `${s} UEFA Europa League`,
    qualifyingArticles: (s) => [
      `${s} UEFA Europa League qualifying`,
      `${s} UEFA Europa League qualifying phase and play-off round`,
    ],
    // The article labels only Q3, so path membership for the other rounds is
    // derived from each side's provenance (see derivePaths in bracket.mjs).
    splitPaths: false,
    derivePaths: true,
    paths: [
      {
        id: "champions",
        label: "Champions Path",
        note: "Clubs eliminated from Champions League qualifying. Enters at the third qualifying round. Only Q3 is labelled by the source; play-off membership is derived from who each side is.",
      },
      {
        id: "main",
        label: "Main Path",
        note: "Domestic-route clubs — league placings, cup winners and title holders — entering from the first qualifying round onward.",
      },
    ],
    defaultPath: "main",
  },
];

COMPETITIONS.push({
  id: "uecl",
  label: "Conference League",
  short: "UECL",
  seasonArticle: (s) => `${s} UEFA Conference League`,
  qualifyingArticles: (s) => [
    `${s} UEFA Conference League qualifying`,
    `${s} UEFA Europa Conference League qualifying`,
    `${s} UEFA Conference League qualifying phase and play-off round`,
  ],
  // Labelled in Q2, Q3 and the play-off round, so the split is taken from the
  // source rather than derived. Q1 is Main Path only and carries no divider.
  splitPaths: true,
  paths: [
    {
      id: "champions",
      label: "Champions Path",
      note: "Clubs eliminated from Champions League and Europa League qualifying. Enters at the second qualifying round.",
    },
    {
      id: "main",
      label: "Main Path",
      note: "Domestic-route clubs — league placings, cup winners and European play-off winners — from the first qualifying round onward.",
    },
  ],
  defaultPath: "main",
});

export const ROUND_ORDER = [
  "First qualifying round",
  "Second qualifying round",
  "Third qualifying round",
  "Play-off round",
];

export const byId = (id) => COMPETITIONS.find((c) => c.id === id);

/** Placeholder entrants appear once a round is drawn but its feeders are not played. */
export const PLACEHOLDER_RE = /^(winner|loser)s?\s+(of|from)\b/i;

const COMP_PREFIX = { CL: "ucl", EL: "uel", ECL: "uecl", CON: "uecl" };

/**
 * Reads a placeholder slot such as "Winner of CP match 3" or, across
 * competitions, "Loser of EL CP match 6" — the loser of Europa League
 * Champions Path match 6.
 */
export function parseReference(text) {
  const m = text.match(
    /^(winner|loser)s?\s+(?:of|from)\s+(?:(CL|EL|ECL|CON)\s+)?(?:(CP|MP|LP)\s+)?match\s+(\d+)$/i
  );
  if (!m) return null;

  return {
    kind: m[1].toLowerCase(), // winner | loser
    competition: m[2] ? COMP_PREFIX[m[2].toUpperCase()] : null, // null = same competition
    path: m[3]
      ? { CP: "champions", MP: "main", LP: "league" }[m[3].toUpperCase()]
      : null,
    matchNumber: Number(m[4]),
  };
}

const ROUND_CODES = {
  Q1: "first qualifying round",
  Q2: "second qualifying round",
  Q3: "third qualifying round",
  PO: "play-off round",
};

const PATH_CODES = { CH: "Champions Path", LP: "League Path", MP: "Main Path" };

const HOLDER_CODES = {
  CON: "Conference League",
  EL: "Europa League",
  CL: "Champions League",
};

/**
 * Entry tokens from the season article's Teams table: "6th", "CW" (domestic cup
 * winners), "CON" (Conference League title holders), or a transfer such as
 * "CL CH Q3" — knocked out of Champions League Champions Path Q3 and moved here.
 */
export function interpretEntry(token) {
  const t = token.trim();

  if (/^\d+(st|nd|rd|th)$/i.test(t)) return { kind: "league", position: t };
  if (/^CW$/i.test(t)) return { kind: "cup" };
  if (/^PW$/i.test(t)) return { kind: "playoff" };

  const transfer = t.match(/^(CL|EL)\s+(CH|LP|MP)?\s*(Q1|Q2|Q3|PO)$/i);
  if (transfer) {
    return {
      kind: "transfer",
      competition: HOLDER_CODES[transfer[1].toUpperCase()],
      // `fromPath`, not `path` — the caller sets `path` to the bucket the club
      // entered *this* competition in, and the two must not collide.
      fromPath: transfer[2] ? PATH_CODES[transfer[2].toUpperCase()] : null,
      round: ROUND_CODES[transfer[3].toUpperCase()],
    };
  }

  const holder = HOLDER_CODES[t.toUpperCase()];
  if (holder) return { kind: "holder", competition: holder };

  return { kind: "other", token: t };
}
