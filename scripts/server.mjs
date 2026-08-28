/**
 * Zero-dependency static server + refresh endpoint.
 *   GET  /                -> index.html
 *   POST /api/refresh     -> scrape the source, write data.json, return it
 *
 * Run: node server.mjs [--port 8080] [--season 2026–27]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { ROOT, refresh } from "./store.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg("port", process.env.PORT ?? 8080));
const DEFAULT_SEASON = arg("season", "2026–27");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const sendJson = (res, status, body) => {
  const buf = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    "content-type": MIME[".json"],
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
};

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, rel === "/" || rel === "\\" ? "index.html" : rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/api/refresh") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
    const season = url.searchParams.get("season") || DEFAULT_SEASON;
    try {
      const data = await refresh(season);
      const summary = data.competitions
        .map((c) => `${c.short}: ${c.source.tieCount} ties${c.stale ? " (stale)" : ""}`)
        .join(", ");
      console.log(`refreshed ${season} -> data.json — ${summary}`);
      for (const e of data.errors ?? []) console.error(`  ! ${e.competition}: ${e.error}`);
      return sendJson(res, 200, data);
    } catch (e) {
      console.error(`refresh failed for ${season}:`, e.message);
      // data.json is left untouched, so the page keeps its last good bracket.
      return sendJson(res, 502, { error: e.message, season });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method not allowed" });
  }
  await serveStatic(req, res, url.pathname);
});

// Loopback only: /api/refresh rewrites data.json with no authentication, and
// this is a local dev server — nothing should reach it from the network.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`bracket:  http://localhost:${PORT}`);
  console.log(`season:   ${DEFAULT_SEASON}  (override with --season)`);
});
