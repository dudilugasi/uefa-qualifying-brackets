/** CLI equivalent of the page's Refresh button: node refresh.mjs [season] */
import { refresh } from "./store.mjs";

const season = process.argv[2] || "2026–27";
try {
  const data = await refresh(season);
  for (const c of data.competitions) {
    const e = c.source.entries ?? {};
    console.log(
      `${c.label} ${c.season}: ${c.source.tieCount} ties` +
        (c.stale ? " (STALE — refetch failed, kept previous)" : "") +
        (e.error ? ` · entries error: ${e.error}` : ` · entries ${e.matched ?? 0} matched`) +
        (e.placeholders ? `, ${e.placeholders} placeholder slots` : "") +
        (e.missing?.length ? `, unmatched: ${e.missing.join(", ")}` : "")
    );
    for (const p of c.paths) {
      for (const r of p.rounds) console.log(`   ${p.label} — ${r.name}: ${r.ties.length}`);
    }
  }
  for (const err of data.errors ?? []) console.error(`  ! ${err.competition}: ${err.error}`);
} catch (e) {
  console.error(`refresh failed: ${e.message}`);
  process.exit(1);
}
