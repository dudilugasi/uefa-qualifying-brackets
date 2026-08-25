const SVG_NS = "http://www.w3.org/2000/svg";

/** Rows that trace a club: tie rows, and the league phase table's rows. */
const HOVERABLE = ".team, .lp-row";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** Teams are objects, but tolerate plain "Name (Country)" strings in hand-edited data. */
function normalizeTeam(team) {
  if (team == null) return { name: "" };
  if (typeof team !== "string") return team;
  const m = team.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { name: m[1], country: m[2] } : { name: team };
}

const sumLegs = (legs) =>
  legs && legs.length
    ? legs.reduce((a, [h, x]) => [a[0] + h, a[1] + x], [0, 0])
    : null;

/** Prefer the source's own winner marking; fall back to aggregate, then pens. */
function decide(tie) {
  if (tie.winner === "home" || tie.winner === "away") return tie.winner;
  // A two-legged tie is not settled by the first leg, whatever the scoreline:
  // judge it only on the article's own aggregate, or once both legs are in.
  if (tie.agg == null && (tie.legs?.length ?? 0) < 2) return null;
  const agg = tie.agg ?? sumLegs(tie.legs);
  if (!agg) return null;
  if (agg[0] !== agg[1]) return agg[0] > agg[1] ? "home" : "away";
  if (tie.pens) return tie.pens[0] > tie.pens[1] ? "home" : "away";
  return null;
}

function teamRow(team, side, tie, isWinner, roundIndex) {
  const row = el(
    "div",
    "team" +
      (isWinner ? " winner" : "") +
      (team.placeholder ? " placeholder" : "") +
      (team.bye ? " bye" : "")
  );
  row.team = team; // read back by the hover card
  row.dataset.team = team.name;
  row.dataset.round = String(roundIndex);
  if (isWinner) row.dataset.advances = "1";
  // An undecided slot points back at the tie that will fill it.
  if (team.ref?.tieKey) row.dataset.refTie = team.ref.tieKey;

  // Kosovo and Northern Ireland have no flag emoji, so show the code instead.
  const flag = team.flag
    ? el("span", "flag", team.flag)
    : el("span", "flag code", (team.code ?? "").replace("gb-", "").toUpperCase());
  if (team.country) flag.title = team.country;
  row.append(flag);

  // `label` is the readable form of a placeholder ("Winner of X v Y").
  const shown = team.bye ? "Bye" : team.label || team.name || "—";
  const nameCell = el("div", "name", shown);
  if (team.country) nameCell.title = `${team.name} (${team.country})`;
  else if (team.label) nameCell.title = team.name; // keep the raw code available
  row.append(nameCell);

  const legs = tie.legs || [];
  for (let i = 0; i < 2; i++) {
    const score = legs[i] ? legs[i][side] : null;
    row.append(el("div", "leg", score == null ? "–" : String(score)));
  }
  const agg = tie.agg ?? sumLegs(legs);
  row.append(el("div", "agg", agg ? String(agg[side]) : ""));
  return row;
}

function tieCard(tie, roundIndex) {
  const home = normalizeTeam(tie.home);
  const away = normalizeTeam(tie.away);
  const winner = decide(tie);
  const played = tie.legs && tie.legs.length;

  const card = el("div", "tie" + (played ? "" : " pending"));
  if (tie.key) card.dataset.tieKey = tie.key;
  if (tie.group) card.append(el("div", "tie-group", tie.group));
  card.append(teamRow(home, 0, tie, winner === "home", roundIndex));
  if (away.name !== "") {
    card.append(teamRow(away, 1, tie, winner === "away", roundIndex));
  }
  if (tie.note) card.append(el("div", "tie-foot", tie.note));
  return card;
}

/** Consecutive ties sharing a `feeds` target render inside one .pair box. */
function groupTies(ties) {
  const groups = [];
  for (const tie of ties) {
    const last = groups[groups.length - 1];
    if (last && tie.feeds != null && last.feeds === tie.feeds) last.ties.push(tie);
    else groups.push({ feeds: tie.feeds ?? null, ties: [tie] });
  }
  return groups;
}

/** Builds one round column: the header plus its ties, grouped by what they feed. */
function roundColumn(name, ties, roundIndex) {
  const col = el("div", "round");
  col.append(el("div", "round-head", name));

  const groups = el("div", "groups");
  for (const group of groupTies(ties)) {
    const pair = el("div", "pair");
    group.ties.forEach((t) => pair.append(tieCard(t, roundIndex)));
    groups.append(pair);
  }
  col.append(groups);
  return col;
}

/** The club a tie sent through, if it's decided and not a placeholder slot. */
function advancingName(tie) {
  const side = decide(tie);
  if (!side) return null;
  const team = normalizeTeam(side === "home" ? tie.home : tie.away);
  return team.placeholder ? null : team.name;
}

/**
 * Which tie in the next round each tie leads into, keyed by position. The tie's
 * own `feeds` is not usable here: in the combined "All" view it is namespaced
 * per path ("champions:3") and indexes that path's round, not the merged one.
 * Linkage is recovered the same way the wires are — the winner turning up a
 * round later, or an undecided slot naming this tie's key.
 */
function successors(rounds) {
  return rounds.map((round, r) => {
    const links = new Map();
    const next = rounds[r + 1]?.ties;
    if (!next) return links;

    round.ties.forEach((tie, i) => {
      const advanced = advancingName(tie);
      const j = next.findIndex((n) =>
        [n.home, n.away].some((raw) => {
          const side = normalizeTeam(raw);
          return (
            (advanced != null && side.name === advanced) ||
            (tie.key != null && side.ref?.tieKey === tie.key)
          );
        })
      );
      if (j !== -1) links.set(i, j);
    });
    return links;
  });
}

/**
 * One tree per tie nothing feeds out of — a final-round tie, or a mid-bracket
 * tie whose winner never reappears (both sides went out, or the next round is
 * undrawn) — carrying everything that feeds it, recursively.
 */
function feederTrees(path) {
  const rounds = path.rounds;
  const leadsTo = successors(rounds);

  const node = (r, i) => ({
    tie: rounds[r].ties[i],
    roundIndex: r,
    feeders:
      r === 0
        ? []
        : rounds[r - 1].ties.flatMap((_, j) =>
            leadsTo[r - 1].get(j) === i ? [node(r - 1, j)] : []
          ),
  });

  const roots = [];
  for (let r = rounds.length - 1; r >= 0; r--) {
    rounds[r].ties.forEach((_, i) => {
      if (!leadsTo[r].has(i)) roots.push(node(r, i));
    });
  }
  return roots;
}

/**
 * "sub" — each tree as its own small bracket, wrapped across the page, so a
 * deep round (UECL main path Q2 is 43 ties) never becomes one endless column
 * and every wire stays inside its own box.
 */
function renderSubBrackets(path, bracket) {
  for (const root of feederTrees(path)) {
    // Ties bucketed by round in the order the walk meets them, so a feeder
    // still sits beside the tie it feeds.
    const byRound = new Map();
    (function walk(node) {
      if (!byRound.has(node.roundIndex)) byRound.set(node.roundIndex, []);
      byRound.get(node.roundIndex).push(node.tie);
      node.feeders.forEach(walk);
    })(root);

    // Every box spans every round, empty where this tree has no tie, so a round
    // sits in the same column whichever box you are reading.
    const sub = el("div", "sub");
    path.rounds.forEach((round, roundIndex) => {
      sub.append(roundColumn(round.name, byRound.get(roundIndex) ?? [], roundIndex));
    });
    bracket.append(sub);
  }
}

function renderPath(path) {
  const bracket = document.getElementById("bracket");
  activePath = path;
  bracket.replaceChildren();
  bracket.className = layout === "sub" ? "bracket subs" : "bracket";

  if (layout === "sub") {
    // The boxes stack in their own column, so the league phase can sit beside
    // them rather than being pushed below the whole pile.
    const stack = el("div", "subs-stack");
    renderSubBrackets(path, stack);
    bracket.append(stack);
  } else {
    path.rounds.forEach((round, roundIndex) => {
      bracket.append(roundColumn(round.name, round.ties, roundIndex));
    });
  }

  // The round after qualifying, sitting where the play-off winners land.
  const competition = payload?.competitions?.find((c) => c.id === selection.competitionId);
  const leaguePhase = competition && leaguePhaseColumn(competition, path.rounds.length);
  if (leaguePhase) bracket.append(leaguePhase);

  drawWires();
  resyncTrace();
}

/** Curve from each advancing team's row to that same team's row one round on. */
function drawWires() {
  const canvas = document.getElementById("canvas");
  const svg = document.getElementById("wires");
  svg.replaceChildren();

  const base = canvas.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${canvas.offsetWidth} ${canvas.offsetHeight}`);

  const wire = (fromRect, toRect, { team, tbd }) => {
    const x1 = fromRect.right - base.left;
    const y1 = fromRect.top + fromRect.height / 2 - base.top;
    const x2 = toRect.left - base.left;
    const y2 = toRect.top + toRect.height / 2 - base.top;
    const bend = Math.max(18, (x2 - x1) * 0.45);
    // The end handle runs back along the straight line between the two rows, so
    // a steep wire arrives at the angle it travels at rather than flattening to
    // horizontal in its last few pixels.
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const cx = x2 - ((x2 - x1) / len) * bend;
    const cy = y2 - ((y2 - y1) / len) * bend;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${cx} ${cy}, ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--wire)");
    path.setAttribute("stroke-width", "1.5");
    if (tbd) path.classList.add("tbd");
    path.dataset.team = team;
    svg.append(path);
  };

  // Decided ties: row of the advancing club -> that club's row next round. The
  // target is matched on the data attributes alone, so the last round wires into
  // the league phase table the same way it wires into a tie.
  for (const from of canvas.querySelectorAll(".team[data-advances]")) {
    const nextRound = Number(from.dataset.round) + 1;
    const to = canvas.querySelector(
      `[data-round="${nextRound}"][data-team="${CSS.escape(from.dataset.team)}"]`
    );
    if (!to) continue;
    wire(from.getBoundingClientRect(), to.getBoundingClientRect(), {
      team: from.dataset.team,
    });
  }

  // Undecided ties: the whole feeding tie -> the "Winner of A v B" slot. Drawn
  // from the tie box because which of the two advances isn't known yet. Skipped
  // when the feeder lives in another tab (a different path or competition).
  for (const slot of canvas.querySelectorAll("[data-ref-tie]")) {
    const source = canvas.querySelector(
      `.tie[data-tie-key="${CSS.escape(slot.dataset.refTie)}"]`
    );
    if (!source) continue;
    wire(source.getBoundingClientRect(), slot.getBoundingClientRect(), {
      team: slot.dataset.team,
      tbd: true,
    });
  }

  if (traced) applyTrace(traced); // survive a redraw (resize, refresh)
}

/** Name of the team whose route is currently marked. */
let traced = null;
let pinned = false;
/** The row the entry bar currently describes, so it isn't rebuilt under the pointer. */
let cardRow = null;

function applyTrace(name) {
  const canvas = document.getElementById("canvas");
  const svg = document.getElementById("wires");

  for (const n of canvas.querySelectorAll(".trace")) n.classList.remove("trace");
  canvas.classList.toggle("tracing", Boolean(name));
  if (!name) return;

  const sel = `[data-team="${CSS.escape(name)}"]`;
  for (const row of canvas.querySelectorAll(`.team${sel}, .lp-row${sel}`)) {
    row.classList.add("trace");
    row.closest(".tie")?.classList.add("trace");
    // Tracing a "Winner of A v B" slot also lights up the tie that decides it.
    if (row.dataset.refTie) {
      canvas
        .querySelector(`.tie[data-tie-key="${CSS.escape(row.dataset.refTie)}"]`)
        ?.classList.add("trace");
    }
  }
  for (const p of svg.querySelectorAll(`path${sel}`)) p.classList.add("trace");
}

function setTrace(name) {
  if (traced === name) return;
  traced = name;
  applyTrace(name);
}

const ORDINAL_WORD = { "1st": "champions", "2nd": "runners-up" };
const COMP_NAMES = { ucl: "Champions League", uel: "Europa League", uecl: "Conference League" };
/** UCL -> UEL -> UECL, so a drop-in chain can't be longer than this. */
const COMPETITION_HOPS = 3;

/**
 * A club that dropped in from another competition only carries its transfer
 * token here ("CL Q1"), so its domestic route is read off the competition it
 * fell out of, where the same club is listed with its real entry.
 */
const originCache = new Map();

const competitionNamed = (name) =>
  (payload?.competitions ?? []).find((c) => c.label === name || COMP_NAMES[c.id] === name) ?? null;

/** The first listing of a club in a competition; its entry is the same in each. */
function clubIn(competition, name) {
  for (const path of competition?.paths ?? []) {
    for (const round of path.rounds) {
      for (const tie of round.ties) {
        for (const raw of [tie.home, tie.away]) {
          const side = normalizeTeam(raw);
          if (side.name === name) return side;
        }
      }
    }
  }
  return null;
}

function originEntry(team) {
  if (team.entry?.kind !== "transfer" || !payload) return null;

  const key = `${team.entry.competition}|${team.name}`;
  if (originCache.has(key)) return originCache.get(key);

  // The competition it fell out of — where the card's link goes.
  const competition = competitionNamed(team.entry.competition);
  const side = competition && clubIn(competition, team.name);

  // The domestic route can be a further competition back: Hearts reach the UECL
  // play-off out of the UEL, having entered the UCL as Scottish runners-up. Keep
  // hopping while the club is still a drop-in there.
  let entry = side?.entry ?? null;
  for (let hop = 0; entry?.kind === "transfer" && hop < COMPETITION_HOPS; hop++) {
    const back = competitionNamed(entry.competition);
    entry = (back ? clubIn(back, team.name) : null)?.entry ?? null;
  }

  // A club with no domestic entry anywhere still links; it just has no route line.
  const found = side ? { competition, entry: entry?.kind === "transfer" ? null : entry } : null;
  originCache.set(key, found);
  return found;
}

/**
 * The other end of the same move: the competition this club drops into after
 * the one on screen, found by the transfer entry there naming this one.
 */
const onwardCache = new Map();
function onwardEntry(team) {
  const current = payload?.competitions?.find((c) => c.id === selection.competitionId);
  if (!current) return null;

  const key = `${current.id}|${team.name}`;
  if (onwardCache.has(key)) return onwardCache.get(key);

  let found = null;
  for (const competition of payload.competitions) {
    if (competition === current) continue;
    const entry = clubIn(competition, team.name)?.entry;
    if (
      entry?.kind === "transfer" &&
      (entry.competition === current.label || entry.competition === COMP_NAMES[current.id])
    ) {
      found = { competition, entry };
      break;
    }
  }

  onwardCache.set(key, found);
  return found;
}

/** Every row for a club in the current view, earliest round first. */
const teamRows = (name) =>
  [...document.querySelectorAll(`#canvas .team[data-team="${CSS.escape(name)}"]`)].sort(
    (a, b) => Number(a.dataset.round) - Number(b.dataset.round)
  );

/**
 * A re-render can change what a marked route means: another competition lists
 * the same club with its own entry data, and a path filter may not list it at
 * all. Re-read the card from what's on screen now, or drop the pin.
 */
function resyncTrace() {
  if (!traced) return;
  const row = teamRows(traced)[0];
  if (!row) unpin();
  else if (pinned) showEntryCard(row);
}

/**
 * Follows a drop-in back to where the club came from: switch competition, then
 * pin the club at the earliest round it appears in there, which re-reads the
 * card off that competition's own entry data.
 */
function showInCompetition(name, competition) {
  selection.competitionId = competition.id;
  selection.pathId = null; // paths don't carry across competitions
  render(payload);

  const row = teamRows(name)[0];
  if (!row) return;

  pinned = true;
  traced = null;
  setTrace(name);
  showEntryCard(row);
  row.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
}

/** Prose for a club's route in, from its league finish or transfer token. */
function howQualified(team) {
  const entry = team.entry;
  if (!entry) return null;

  const where = team.country ? ` of ${team.country}` : "";
  let how;

  switch (entry.kind) {
    case "league": {
      const word = ORDINAL_WORD[entry.position?.toLowerCase()];
      how = word
        ? `Domestic league ${word}${where} (${entry.position})`
        : `Finished ${entry.position}${where}`;
      break;
    }
    case "cup":
      how = `Domestic cup winners${where}`;
      break;
    case "playoff":
      how = `Won the European qualification play-off${where}`;
      break;
    case "holder":
      how = `${entry.competition} title holders`;
      break;
    case "transfer":
      how =
        `Dropped in from the ${entry.competition}` +
        (entry.fromPath ? ` ${entry.fromPath}` : "") +
        (entry.round ? `, ${entry.round}` : "");
      break;
    default:
      how = `Entry code: ${entry.token}`;
  }

  const PATH_LABEL = { league: "League Path", champions: "Champions Path", main: "Main Path" };
  const bits = [];
  if (PATH_LABEL[entry.path]) bits.push(PATH_LABEL[entry.path]);
  return { how, sub: bits.join(" · ") };
}

function showEntryCard(row) {
  const card = document.getElementById("entry-card");
  const team = row.team;
  if (!team) return;
  // pointerover fires again for every cell within one row, and rebuilding the
  // bar would destroy the link under the pointer mid-hover.
  if (cardRow === row && card.classList.contains("show")) return;
  cardRow = row;

  card.replaceChildren();
  const heading = team.bye ? "Bye" : team.label || team.name;
  card.append(el("div", "ec-team", `${team.flag ? team.flag + " " : ""}${heading}`));

  const info = howQualified(team);

  if (team.bye) {
    card.append(el("div", "ec-none", "No opponent — advances automatically"));
  } else if (team.placeholder) {
    if (team.ref) {
      card.append(el("div", "ec-how", `${team.ref.kind === "winner" ? "Winner" : "Loser"} of ${team.ref.fixture}`));
      card.append(
        el(
          "div",
          "ec-sub",
          `${COMP_NAMES[team.ref.competition] ?? team.ref.competition} · ` +
            `${team.ref.round.toLowerCase()} · not yet played`
        )
      );
    } else {
      card.append(el("div", "ec-none", `Slot filled by an unplayed tie (${team.name})`));
    }
  } else if (info) {
    // For a drop-in, that line only says where the club fell from: make it a
    // link into that competition, and spell out the domestic route beneath it.
    const origin = originEntry(team);
    if (origin) {
      const link = el("button", "ec-how ec-link", info.how);
      link.type = "button";
      link.title = `Show ${team.name} in the ${origin.competition.label}`;
      link.addEventListener("click", () => showInCompetition(team.name, origin.competition));
      card.append(link);
      const originHow = howQualified({ country: team.country, entry: origin.entry })?.how;
      if (originHow) card.append(el("div", "ec-sub", originHow));
    } else {
      card.append(el("div", "ec-how", info.how));
    }
    if (info.sub) card.append(el("div", "ec-sub", info.sub));
    if (team.via) {
      card.append(el("div", "ec-sub", `Reached here as ${team.via.kind} of ${team.via.fixture}`));
    }
    appendOnwardLink(card, team);
  } else {
    card.append(el("div", "ec-none", "qualification route unknown"));
    appendOnwardLink(card, team);
  }

  card.classList.add("show");
  card.setAttribute("aria-hidden", "false");
}

/** Where the club goes next, if it drops into another competition from here. */
function appendOnwardLink(card, team) {
  const onward = onwardEntry(team);
  if (!onward) return;

  const round = onward.entry.entryRound ? `, ${onward.entry.entryRound.toLowerCase()}` : "";
  const link = el("button", "ec-link", `Dropped to the ${onward.competition.label}${round}`);
  link.type = "button";
  link.title = `Show ${team.name} in the ${onward.competition.label}`;
  link.addEventListener("click", () => showInCompetition(team.name, onward.competition));
  card.append(link);
}

function unpin() {
  pinned = false;
  setTrace(null);
  hideEntryCard();
}

function hideEntryCard() {
  const card = document.getElementById("entry-card");
  cardRow = null;
  card.classList.remove("show");
  card.setAttribute("aria-hidden", "true");
}

function initTraceEvents() {
  const bracket = document.getElementById("bracket");
  const card = document.getElementById("entry-card");
  const inside = (node, root) => root.contains(node instanceof Node ? node : null);
  const hits = (node, x, y) => {
    const r = node.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  /**
   * Is the pointer heading into `root`? relatedTarget is null when the hit
   * target changed because an element moved under a still pointer — the bar
   * sliding up over the row you are hovering — and reading that as "the pointer
   * left" hid the bar, which uncovered the row, which showed the bar again.
   */
  const towards = (ev, root) =>
    inside(ev.relatedTarget, root) ||
    (!ev.relatedTarget && hits(root, ev.clientX, ev.clientY));

  // While a route is pinned, hovering elsewhere changes neither the arrows nor
  // the card — both stay on the pinned team until it's unpinned.
  // pointerover, not pointerenter: moving off a row onto tie chrome or the gaps
  // between columns has to clear the trace, not wait for the bracket's edge.
  bracket.addEventListener("pointerover", (ev) => {
    if (pinned) return;
    const row = ev.target.closest(HOVERABLE);
    if (!row) {
      setTrace(null);
      hideEntryCard();
      return;
    }
    setTrace(row.dataset.team);
    showEntryCard(row);
  });

  // Moving down onto the bar isn't leaving the row it describes, so the route
  // survives; leaving the bar for anywhere but the tree clears it.
  bracket.addEventListener("pointerleave", (ev) => {
    if (pinned || towards(ev, card)) return;
    setTrace(null);
    hideEntryCard();
  });

  card.addEventListener("pointerleave", (ev) => {
    if (pinned || towards(ev, bracket)) return;
    setTrace(null);
    hideEntryCard();
  });

  // Hover doesn't exist on touch, so a tap pins the route instead. The bar is
  // pointer-transparent, so a click on it lands on the row behind: drop those.
  bracket.addEventListener("click", (ev) => {
    const row = ev.target.closest(HOVERABLE);
    if (!row || (card.classList.contains("show") && hits(card, ev.clientX, ev.clientY))) return;
    if (pinned && traced === row.dataset.team) {
      unpin();
    } else {
      pinned = true;
      traced = null;
      setTrace(row.dataset.team);
      showEntryCard(row);
    }
  });

  addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && pinned) unpin();
  });
}

/** Survives refreshes so the view doesn't jump back to the first tab. */
const selection = { competitionId: null, pathId: null };

/** The whole loaded payload, so one competition's card can read another's. */
let payload = null;

/** "columns" — one column per round; "sub" — a small bracket per tie. */
let layout = "columns";
let activePath = null; // re-rendered in place when the layout switches

const LAYOUTS = [
  ["columns", "Columns", "One column per round, every tie stacked"],
  ["sub", "Sub-brackets", "One bracket per tie, with everything that feeds it"],
];

function renderLayoutSwitch() {
  const wrap = document.getElementById("layout-switch");
  wrap.replaceChildren();

  for (const [id, label, hint] of LAYOUTS) {
    const btn = el("button", "tab", label);
    btn.type = "button";
    btn.title = hint;
    btn.setAttribute("aria-selected", String(layout === id));
    btn.addEventListener("click", () => {
      if (layout === id) return;
      layout = id;
      renderLayoutSwitch();
      if (activePath) renderPath(activePath);
    });
    wrap.append(btn);
  }
}

const ROUND_SEQUENCE = [
  "First qualifying round",
  "Second qualifying round",
  "Third qualifying round",
  "Play-off round",
];
const roundRank = (name) => {
  const i = ROUND_SEQUENCE.indexOf(name);
  return i === -1 ? ROUND_SEQUENCE.length : i;
};

/**
 * A combined view of every path in a competition. Ties that belong to two paths
 * (the merged UEL play-off) are listed once, and `feeds` is namespaced per path
 * so the pair-grouping doesn't fuse unrelated ties that happen to sit adjacent.
 */
function buildAllPath(competition) {
  const paths = competition.paths ?? [];
  if (paths.length < 2) return null;

  const names = [];
  for (const path of paths) {
    for (const round of path.rounds) if (!names.includes(round.name)) names.push(round.name);
  }
  names.sort((a, b) => roundRank(a) - roundRank(b));

  const rounds = names
    .map((name) => {
      const ties = [];
      const seen = new Set();
      for (const path of paths) {
        const round = path.rounds.find((r) => r.name === name);
        if (!round) continue;
        for (const tie of round.ties) {
          if (tie.key) {
            if (seen.has(tie.key)) continue;
            seen.add(tie.key);
          }
          ties.push({
            ...tie,
            // In the combined view the tabs no longer say which path a tie is
            // in, so badge it. A tie already labelled (the merged UEL play-off,
            // "Champions + Main Path") keeps its own wording.
            group: tie.group ?? path.label,
            feeds: tie.feeds == null ? null : `${path.id}:${tie.feeds}`,
          });
        }
      }
      return { name, ties };
    })
    .filter((r) => r.ties.length);

  return {
    id: "__all",
    label: "All",
    note: `Every tie in ${competition.label} qualifying, both paths in one bracket.`,
    rounds,
  };
}

/**
 * The tabs are filters, not an exclusive tab set: nothing selected means every
 * path at once (the default), clicking a path narrows to it, and clicking the
 * selected one again clears back to the combined view.
 */
function renderPathTabs(competition) {
  const tabs = document.getElementById("tabs");
  tabs.replaceChildren();

  const paths = competition.paths ?? [];
  const combined = buildAllPath(competition);
  tabs.hidden = paths.length < 2;

  const selected = paths.find((p) => p.id === selection.pathId) ?? null;
  // Without a combined view (single-path competition) there is nothing to fall
  // back to, so that lone path stays on screen.
  const active = selected ?? combined ?? paths[0];
  selection.pathId = selected?.id ?? null;

  paths.forEach((path) => {
    const btn = el("button", "tab", path.label);
    btn.type = "button";
    btn.dataset.pathId = path.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(path === selected));
    btn.title = path === selected ? "Click again to show all paths" : `Show only ${path.label}`;
    btn.addEventListener("click", () => {
      selection.pathId = selection.pathId === path.id ? null : path.id;
      renderPathTabs(competition);
    });
    tabs.append(btn);
  });

  if (active) renderPath(active);
}

/**
 * The round after qualifying, which no bracket table covers: the clubs the
 * season article lists as entering there, plus the play-off winners that fill
 * the rest of the slots. A tie merged across paths is listed under both, so the
 * play-off pass dedupes by key.
 */
function leaguePhaseSlots(competition) {
  const slots = [...(competition.leaguePhase?.entrants ?? [])];

  const seen = new Set();
  for (const path of competition.paths ?? []) {
    const round = path.rounds[path.rounds.length - 1];
    for (const tie of round?.ties ?? []) {
      if (tie.key) {
        if (seen.has(tie.key)) continue;
        seen.add(tie.key);
      }
      const side = decide(tie);
      if (side) {
        slots.push(normalizeTeam(side === "home" ? tie.home : tie.away));
      } else {
        const home = normalizeTeam(tie.home);
        const away = normalizeTeam(tie.away);
        const label = `Winner of ${home.label || home.name} v ${away.label || away.name}`;
        slots.push({ placeholder: true, name: label, label, tieKey: tie.key });
      }
    }
  }

  // A slot the article knows only as a token — "(EL PO)" — reads off its entry.
  for (const slot of slots) {
    if (slot.name || !slot.entry) continue;
    const { competition: from, round } = slot.entry;
    slot.label = from ? `${from}${round ? ` ${round}` : ""}` : slot.entry.token;
    slot.name = slot.label;
  }

  // Decided first, whatever order they were found in; undecided slots last.
  return [...slots.filter((s) => !s.placeholder), ...slots.filter((s) => s.placeholder)];
}

const LEAGUE_PHASE_COLUMNS = ["#", "Team", "W", "D", "L", "Pts"];

/** The league phase as a final column of the bracket, one row per slot. */
function leaguePhaseColumn(competition, roundIndex) {
  const slots = leaguePhaseSlots(competition);
  if (!slots.length) return null;

  const col = el("div", "round league-round");
  col.append(el("div", "round-head", competition.leaguePhase?.name ?? "League phase"));

  const table = el("table", "lp-table");
  const thead = el("thead");
  const headRow = el("tr");
  LEAGUE_PHASE_COLUMNS.forEach((label) => headRow.append(el("th", null, label)));
  thead.append(headRow);
  table.append(thead);

  const body = el("tbody");
  slots.forEach((slot) => {
    const tr = el("tr", "lp-row" + (slot.placeholder ? " lp-pending" : ""));
    // Same hooks a tie row carries, so hover, tracing, the card and the wires
    // all reach into this column too.
    tr.team = slot;
    tr.dataset.team = slot.name ?? "";
    tr.dataset.round = String(roundIndex);
    if (slot.tieKey) tr.dataset.refTie = slot.tieKey;
    // No standings until the league phase kicks off; the article has no table yet.
    tr.append(el("td", "lp-place", "–"));

    const name = el("td", "lp-name");
    if (slot.flag) name.append(el("span", "flag", slot.flag));
    else if (slot.code) name.append(el("span", "flag code", slot.code.replace("gb-", "").toUpperCase()));
    name.append(el("span", "lp-club", slot.placeholder ? slot.label ?? "Undecided slot" : slot.name));
    tr.append(name);

    for (let i = 0; i < 4; i++) tr.append(el("td", "lp-stat", "–"));
    body.append(tr);
  });
  table.append(body);
  col.append(table);
  return col;
}

function renderCompetition(competition) {
  selection.competitionId = competition.id;
  document.getElementById("season").textContent = competition.season ?? "";
  renderPathTabs(competition);
}

function render(data) {
  payload = data; // kept for lookups that cross competitions
  originCache.clear();
  onwardCache.clear();

  const competitions = data.competitions ?? [];
  const status = document.getElementById("status");
  status.textContent = data.fetchedAt
    ? "updated " + new Date(data.fetchedAt).toLocaleString()
    : "";

  const compTabs = document.getElementById("comp-tabs");
  compTabs.replaceChildren();

  let active =
    competitions.find((c) => c.id === selection.competitionId) ?? competitions[0];

  competitions.forEach((competition) => {
    const btn = el("button", "comp-tab", competition.label);
    btn.type = "button";
    btn.dataset.competitionId = competition.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(competition === active));
    if (competition.stale) {
      btn.append(el("span", "stale-dot", "•"));
      btn.title = "Last refresh failed for this competition — showing previous data";
    }
    btn.addEventListener("click", () => {
      [...compTabs.children].forEach((b) => b.setAttribute("aria-selected", "false"));
      btn.setAttribute("aria-selected", "true");
      selection.pathId = null; // paths differ between competitions
      renderCompetition(competition);
    });
    compTabs.append(btn);
  });

  // Per-competition fetch failures are reported without hiding what did load.
  const notes = [];
  if (data.errors?.length) {
    notes.push(
      "Failed to refresh: " +
        data.errors.map((e) => `${e.competition} (${e.error})`).join("; ") +
        " — showing the last saved data for those."
    );
  }
  // A failed entry lookup used to be invisible, showing "route unknown" per club.
  for (const w of data.entryWarnings ?? []) {
    notes.push(
      `${w.competition.toUpperCase()}: qualification routes could not be fetched (${w.error})` +
        (w.carriedOver
          ? ` — reused ${w.carriedOver} routes from the previous refresh.`
          : " — hover cards will show “route unknown”.")
    );
  }
  if (notes.length) showError(notes.join(" "));
  else clearError();

  if (active) renderCompetition(active);
}

function showError(msg) {
  const banner = document.getElementById("banner");
  banner.textContent = msg;
  banner.hidden = false;
}
const clearError = () => (document.getElementById("banner").hidden = true);

async function loadLocal() {
  let data;
  // Only the read is reported as a read failure: a render that throws used to
  // surface as "could not read data.json", pointing at the wrong thing.
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`data.json ${res.status}`);
    data = await res.json();
  } catch (e) {
    showError(
      "Could not read data.json — " + e.message +
      ". Serve this page with `node server.mjs` (opening the file directly blocks fetch)."
    );
    return;
  }

  try {
    render(data);
  } catch (e) {
    showError(`Could not render the bracket — ${e.message}. Try a hard reload (a stale app.js does this).`);
  }
}

document.getElementById("refresh").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  const status = document.getElementById("status");
  btn.disabled = true;
  status.textContent = "fetching…";
  clearError();

  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `refresh failed (${res.status})`);
    render(body); // server already wrote data.json
  } catch (e) {
    showError("Refresh failed: " + e.message + " — showing the last saved data.");
    await loadLocal();
  } finally {
    btn.disabled = false;
  }
});

/**
 * Static hosting (GitHub Pages) has no /api/refresh, so the button can't work
 * there — the page still renders the committed data.json. Drop the button
 * rather than leaving a control that only produces an error.
 */
async function detectRefreshSupport() {
  try {
    // The local server answers any non-POST on this path with 405; static
    // hosting has no such route at all.
    const res = await fetch("/api/refresh", { method: "GET", cache: "no-store" });
    if (res.status === 405 || res.status === 200) return;
  } catch {
    /* fall through to the static case */
  }
  document.getElementById("refresh")?.remove();
}

// Card positions shift with width and with font loading; keep the wires on them.
addEventListener("resize", drawWires);
if (document.fonts?.ready) document.fonts.ready.then(drawWires);

initTraceEvents();
renderLayoutSwitch();
loadLocal();
detectRefreshSupport();
