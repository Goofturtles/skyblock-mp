/**
 * skyblock-mp — static host + live price service.
 *
 *   node server.js            -> http://localhost:3512
 *
 * /api/prices sweeps every Auction House page (public, no API key), decodes each
 * BIN accessory's NBT to get its real item id, and returns the lowest BIN per
 * (item, rarity, recombobulated?). ~5s per sweep, cached for 3 minutes.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const NBT = require("./nbt.js");

const PORT = 3512;
const CACHE_MS = 3 * 60 * 1000;
const PAGE_CONCURRENCY = 16; // measured: 16 halves the sweep vs 8, 24 gains nothing

const MIME = {
  ".html": "text/html;charset=utf-8", ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8", ".json": "application/json;charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

let cache = null;      // { at, payload }
let inFlight = null;   // de-dupes concurrent sweeps

async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": "skyblock-mp/1.0 (personal tool)" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function sweepAuctions() {
  const started = Date.now();
  const first = await getJSON("https://api.hypixel.net/v2/skyblock/auctions?page=0");
  const pages = [first];

  for (let start = 1; start < first.totalPages; start += PAGE_CONCURRENCY) {
    const batch = [];
    for (let p = start; p < Math.min(start + PAGE_CONCURRENCY, first.totalPages); p++) {
      batch.push(getJSON(`https://api.hypixel.net/v2/skyblock/auctions?page=${p}`).catch(() => null));
    }
    pages.push(...(await Promise.all(batch)).filter(Boolean));
  }

  const lowest = Object.create(null);
  let scanned = 0, undecodable = 0;

  for (const page of pages) {
    for (const a of page.auctions || []) {
      if (!a.bin || a.category !== "accessories") continue;
      scanned++;
      let id, recombobulated;
      try {
        const items = await NBT.decodeItems(a.item_bytes);
        const extra = items[0] && items[0].tag && items[0].tag.ExtraAttributes;
        if (!extra || !extra.id) { undecodable++; continue; }
        id = extra.id;
        recombobulated = extra.rarity_upgrades ? 1 : 0;
      } catch { undecodable++; continue; }

      const key = `${id}|${a.tier}|${recombobulated}`;
      const cur = lowest[key];
      if (!cur) lowest[key] = { price: a.starting_bid, count: 1 };
      else { cur.count++; if (a.starting_bid < cur.price) cur.price = a.starting_bid; }
    }
  }

  let recombobulator = null;
  try {
    const bz = await getJSON("https://api.hypixel.net/v2/skyblock/bazaar");
    const p = bz.products.RECOMBOBULATOR_3000;
    if (p) recombobulator = { buy: p.quick_status.buyPrice, sell: p.quick_status.sellPrice };
  } catch { /* bazaar is optional */ }

  return {
    generated: Date.now(),
    auctionsUpdated: first.lastUpdated,
    pages: pages.length,
    expectedPages: first.totalPages,
    scanned,
    undecodable,
    items: Object.keys(lowest).length,
    sweepMs: Date.now() - started,
    recombobulator,
    lowestBin: lowest,
  };
}

function prices() {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.payload);
  if (inFlight) return inFlight;
  inFlight = sweepAuctions()
    .then((payload) => { cache = { at: Date.now(), payload }; return payload; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    // A malformed path (`/%`) throws in decodeURIComponent; without this the
    // rejection is unhandled and takes the whole server down.
    if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
  }
});

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/prices") {
    try {
      const payload = await prices();
      const body = JSON.stringify(payload);
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(body);
      console.log(`/api/prices -> ${payload.items} entries, ${(body.length / 1024).toFixed(0)}KB` +
        (Date.now() - cache.at < 1000 ? ` (fresh sweep ${payload.sweepMs}ms, ${payload.pages}/${payload.expectedPages} pages)` : " (cached)"));
    } catch (e) {
      res.writeHead(502, { "content-type": MIME[".json"] });
      res.end(JSON.stringify({ error: String(e.message || e) }));
      console.error("/api/prices failed:", e.message);
    }
    return;
  }

  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(__dirname, p);
  if (file !== __dirname && !file.startsWith(__dirname + path.sep)) { res.writeHead(403).end("forbidden"); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("404"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}

server.listen(PORT, () => {
  console.log(`skyblock-mp  ->  http://localhost:${PORT}`);
  prices().then((p) => console.log(`warm cache: ${p.items} priced accessories in ${p.sweepMs}ms`)).catch(() => {});
});
