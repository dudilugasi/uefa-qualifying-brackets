const SVG_NS = "http://www.w3.org/2000/svg";

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

function renderPath(path) {
  const bracket = document.getElementById("bracket");
  bracket.replaceChildren();

  path.rounds.forEach((round, roundIndex) => {
    const col = el("div", "round");
    const head = el("div", "round-head", round.name);
    col.append(head);

    const groups = el("div", "groups");
    for (const group of groupTies(round.ties)) {
      const pair = el("div", "pair");
      group.ties.forEach((t) => pair.append(tieCard(t, roundIndex)));
      groups.append(pair);
    }
    col.append(groups);
    bracket.append(col);
  });

  drawWires();
}

/** Curve from each advancing team's row to that same team's row one round on. */
function drawWires() {
  const canvas = document.getElementById("canvas");
  const svg = document.getElementById("wires");
  svg.replaceChildren();

  const base = canvas.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${canvas.offsetWidth} ${canvas.offsetHeight}`);

  // Two markers, since a marker can't inherit the referencing path's class.
  const defs = document.createElementNS(SVG_NS, "defs");
  for (const [id, fill] of [["arrow", "var(--wire)"], ["arrow-trace", "var(--trace)"]]) {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto-start-reverse");
    const head = document.createElementNS(SVG_NS, "path");
    head.setAttribute("d", "M 0 1 L 10 5 L 0 9 z");
    head.setAttribute("fill", fill);
    marker.append(head);
    defs.append(marker);
  }
  svg.append(defs);

  const wire = (fromRect, toRect, { team, tbd }) => {
    const x1 = fromRect.right - base.left;
    const y1 = fromRect.top + fromRect.height / 2 - base.top;
    const x2 = toRect.left - base.left;
    const y2 = toRect.top + toRect.height / 2 - base.top;
    const bend = Math.max(18, (x2 - x1) * 0.45);

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--wire)");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("marker-end", "url(#arrow)");
    if (tbd) path.classList.add("tbd");
    path.dataset.team = team;
    svg.append(path);
  };

  // Decided ties: row of the advancing club -> that club's row next round.
  for (const from of canvas.querySelectorAll(".team[data-advances]")) {
    const nextRound = Number(from.dataset.round) + 1;
    const to = canvas.querySelector(
      `.team[data-round="${nextRound}"][data-team="${CSS.escape(from.dataset.team)}"]`
    );
    if (!to) continue;
    wire(from.getBoundingClientRect(), to.getBoundingClientRect(), {
      team: from.dataset.team,
    });
  }

  // Undecided ties: the whole feeding tie -> the "Winner of A v B" slot. Drawn
  // from the tie box because which of the two advances isn't known yet. Skipped
  // when the feeder lives in another tab (a different path or competition).
  for (const slot of canvas.querySelectorAll(".team[data-ref-tie]")) {
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

function applyTrace(name) {
  const canvas = document.getElementById("canvas");
  const svg = document.getElementById("wires");

  for (const n of canvas.querySelectorAll(".trace")) n.classList.remove("trace");
  for (const p of svg.querySelectorAll("path")) {
    p.setAttribute("marker-end", "url(#arrow)");
  }
  canvas.classList.toggle("tracing", Boolean(name));
  if (!name) return;

  const sel = `[data-team="${CSS.escape(name)}"]`;
  for (const row of canvas.querySelectorAll(`.team${sel}`)) {
    row.classList.add("trace");
    row.closest(".tie")?.classList.add("trace");
    // Tracing a "Winner of A v B" slot also lights up the tie that decides it.
    if (row.dataset.refTie) {
      canvas
        .querySelector(`.tie[data-tie-key="${CSS.escape(row.dataset.refTie)}"]`)
        ?.classList.add("trace");
    }
  }
  for (const p of svg.querySelectorAll(`path${sel}`)) {
    p.classList.add("trace");
    p.setAttribute("marker-end", "url(#arrow-trace)");
  }
}

function setTrace(name) {
  if (traced === name) return;
  traced = name;
  applyTrace(name);
}

const ORDINAL_WORD = { "1st": "champions", "2nd": "runners-up" };

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
  if (entry.entryRound) bits.push(`entered at the ${entry.entryRound.toLowerCase()}`);
  if (PATH_LABEL[entry.path]) bits.push(PATH_LABEL[entry.path]);
  return { how, sub: bits.join(" · ") };
}

function showEntryCard(row) {
  const card = document.getElementById("entry-card");
  const team = row.team;
  if (!team) return;

  card.replaceChildren();
  const heading = team.bye ? "Bye" : team.label || team.name;
  card.append(el("div", "ec-team", `${team.flag ? team.flag + " " : ""}${heading}`));

  const COMP_NAMES = { ucl: "Champions League", uel: "Europa League", uecl: "Conference League" };
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
    card.append(el("div", "ec-how", info.how));
    if (info.sub) card.append(el("div", "ec-sub", info.sub));
    if (team.via) {
      card.append(el("div", "ec-sub", `Reached here as ${team.via.kind} of ${team.via.fixture}`));
    }
  } else {
    card.append(el("div", "ec-none", "qualification route unknown"));
  }

  card.classList.add("show");
  card.setAttribute("aria-hidden", "false");
}

function hideEntryCard() {
  const card = document.getElementById("entry-card");
  card.classList.remove("show");
  card.setAttribute("aria-hidden", "true");
}

function initTraceEvents() {
  const bracket = document.getElementById("bracket");

  bracket.addEventListener("pointerover", (ev) => {
    const row = ev.target.closest(".team");
    if (!row) return;
    if (!pinned) setTrace(row.dataset.team);
    showEntryCard(row);
  });

  bracket.addEventListener("pointerleave", () => {
    if (!pinned) setTrace(null);
    hideEntryCard();
  });


  // Hover doesn't exist on touch, so a tap pins the route instead.
  bracket.addEventListener("click", (ev) => {
    const row = ev.target.closest(".team");
    if (!row) return;
    if (pinned && traced === row.dataset.team) {
      pinned = false;
      setTrace(null);
    } else {
      pinned = true;
      traced = null;
      setTrace(row.dataset.team);
    }
    
  });

  addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && pinned) {
      pinned = false;
      setTrace(null);
    }
  });
}

/** Survives refreshes so the view doesn't jump back to the first tab. */
const selection = { competitionId: null, pathId: null };

function renderSource(competition) {
  const src = document.getElementById("source");
  src.replaceChildren();
  if (!competition?.source?.url) return;

  src.append("· source: ");
  const a = el("a", null, competition.source.article || competition.source.name);
  a.href = competition.source.url;
  a.target = "_blank";
  a.rel = "noopener";
  src.append(a);
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

function renderCompetition(competition) {
  selection.competitionId = competition.id;
  document.getElementById("season").textContent = competition.season ?? "";
  renderSource(competition);
  renderPathTabs(competition);
}

function render(data) {
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
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`data.json ${res.status}`);
    render(await res.json());
  } catch (e) {
    showError(
      "Could not read data.json — " + e.message +
      ". Serve this page with `node server.mjs` (opening the file directly blocks fetch)."
    );
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
loadLocal();
detectRefreshSupport();
