/**
 * Accessory-bag proxy.
 *
 * The site is static, so it cannot hold a Hypixel API key. This is the same trick
 * SkyCrypt uses: one small server holds the key, and visitors just type a username.
 *
 *   GET /bag?name=<username>
 *     -> { username, uuid, profile, accessories: [{ id, recomb }], count }
 *
 * The key lives only in the HYPIXEL_KEY environment variable — never in this file,
 * never in the repo, never sent to the browser.
 *
 * Zero dependencies: Node 18+ has fetch, and zlib/http are built in.
 */
const http = require("http");
const zlib = require("zlib");

const PORT = process.env.PORT || 3513;
const KEY = process.env.HYPIXEL_KEY || "";

// Only these origins may call the proxy, so the key cannot be borrowed by other sites.
const ALLOWED = new Set([
  "https://goofturtles.github.io",
  "http://localhost:3512",
  "http://127.0.0.1:3512",
]);

const CACHE_MS = 3 * 60 * 1000;   // protects the key's rate limit
const RATE_MAX = 30;              // requests per IP per window
const RATE_WINDOW = 60 * 1000;

const cache = new Map();          // uuid -> { at, payload }
const hits = new Map();           // ip -> { at, n }

/* ---------------- minimal NBT ---------------- */

function readNBT(buf) {
  let o = 0;
  const u8 = () => buf.readUInt8(o++);
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const str = () => { const l = buf.readUInt16BE(o); o += 2; const s = buf.toString("utf8", o, o + l); o += l; return s; };
  function val(t) {
    switch (t) {
      case 1: { const v = buf.readInt8(o); o += 1; return v; }
      case 2: { const v = buf.readInt16BE(o); o += 2; return v; }
      case 3: return i32();
      case 4: { const v = buf.readBigInt64BE(o); o += 8; return Number(v); }
      case 5: { const v = buf.readFloatBE(o); o += 4; return v; }
      case 6: { const v = buf.readDoubleBE(o); o += 8; return v; }
      case 7: { const n = i32(); o += n; return null; }
      case 8: return str();
      case 9: { const it = u8(), n = i32(), a = []; for (let i = 0; i < n; i++) a.push(val(it)); return a; }
      case 10: { const c = {}; for (;;) { const tt = u8(); if (tt === 0) break; c[str()] = val(tt); } return c; }
      case 11: { const n = i32(); o += n * 4; return null; }
      case 12: { const n = i32(); o += n * 8; return null; }
      default: throw new Error("bad NBT tag " + t);
    }
  }
  if (u8() !== 10) throw new Error("NBT root is not a compound");
  str();
  return val(10);
}

/* ---------------- helpers ---------------- */

async function getJSON(url, opts) {
  const r = await fetch(url, { headers: { "user-agent": "skyblock-mp-proxy/1.0" }, ...opts });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body };
}

/**
 * Username -> uuid. Three sources because ashcon alone 404s some real accounts
 * (it did for "goofturtle"); Mojang's own API has no CORS but works fine server-side.
 */
async function resolveUuid(name) {
  const n = encodeURIComponent(name);
  const sources = [
    { url: `https://api.mojang.com/users/profiles/minecraft/${n}`, pick: (j) => j && j.id ? { uuid: j.id, username: j.name } : null },
    { url: `https://playerdb.co/api/player/minecraft/${n}`, pick: (j) => j?.data?.player?.raw_id ? { uuid: j.data.player.raw_id, username: j.data.player.username } : null },
    { url: `https://api.minetools.eu/uuid/${n}`, pick: (j) => j && j.status === "OK" && j.id ? { uuid: j.id, username: j.name || name } : null },
  ];
  let definiteMiss = false;
  for (const s of sources) {
    try {
      const { body } = await getJSON(s.url);
      const hit = body && s.pick(body);
      if (hit) return hit;
      if (body) definiteMiss = true;
    } catch { /* next */ }
  }
  const e = new Error(definiteMiss
    ? `No Minecraft account called "${name}".`
    : "Could not reach any username lookup service.");
  e.code = definiteMiss ? 404 : 503;
  throw e;
}

function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > RATE_WINDOW) { hits.set(ip, { at: now, n: 1 }); return false; }
  h.n++;
  return h.n > RATE_MAX;
}

async function readBag(name) {
  const { uuid, username } = await resolveUuid(name);

  const cached = cache.get(uuid);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.payload;

  const { body } = await getJSON(`https://api.hypixel.net/v2/skyblock/profiles?uuid=${uuid}`, {
    headers: { "API-Key": KEY, "user-agent": "skyblock-mp-proxy/1.0" },
  });

  if (!body || body.success !== true) {
    const e = new Error(body?.cause || "Hypixel rejected the request.");
    e.code = /key/i.test(body?.cause || "") ? 502 : 400;
    throw e;
  }
  if (!body.profiles || !body.profiles.length) {
    const e = new Error(`${username} has no SkyBlock profiles.`); e.code = 404; throw e;
  }

  const profile = body.profiles.find((p) => p.selected) || body.profiles[0];
  const member = profile.members[uuid];
  const blob = member?.inventory?.bag_contents?.talisman_bag?.data ?? member?.talisman_bag?.data;

  if (!blob) {
    const e = new Error(
      `${username}'s accessory bag is private. In SkyBlock, run /api and switch Inventory API on, then try again.`);
    e.code = 403;
    throw e;
  }

  const items = readNBT(zlib.gunzipSync(Buffer.from(blob, "base64"))).i || [];
  const seen = new Map();
  for (const it of items) {
    const extra = it?.tag?.ExtraAttributes;
    if (!extra?.id) continue;
    const recomb = !!extra.rarity_upgrades;
    // Keep the recombobulated copy when a player holds duplicates.
    if (!seen.has(extra.id) || (recomb && !seen.get(extra.id).recomb)) seen.set(extra.id, { id: extra.id, recomb });
  }

  const payload = {
    username,
    uuid,
    profile: profile.cute_name,
    accessories: [...seen.values()],
    count: seen.size,
    fetched: Date.now(),
  };
  cache.set(uuid, { at: Date.now(), payload });
  return payload;
}

/* ---------------- server ---------------- */

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (origin && ALLOWED.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }

  if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, keyConfigured: KEY.length > 0, cached: cache.size }));
    return;
  }

  if (url.pathname !== "/bag") { res.writeHead(404, headers); res.end(JSON.stringify({ error: "Not found" })); return; }

  if (!KEY) {
    res.writeHead(503, headers);
    res.end(JSON.stringify({ error: "This proxy has no Hypixel API key configured yet." }));
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (rateLimited(ip)) {
    res.writeHead(429, headers);
    res.end(JSON.stringify({ error: "Too many lookups — wait a minute and try again." }));
    return;
  }

  const name = (url.searchParams.get("name") || "").trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ error: "That is not a valid Minecraft username." }));
    return;
  }

  try {
    const payload = await readBag(name);
    res.writeHead(200, headers);
    res.end(JSON.stringify(payload));
    console.log(`bag ${payload.username}/${payload.profile}: ${payload.count} accessories`);
  } catch (e) {
    const code = e.code || 500;
    res.writeHead(code, headers);
    res.end(JSON.stringify({ error: String(e.message || e) }));
    console.warn(`bag ${name} failed (${code}): ${e.message}`);
  }
}).listen(PORT, () => {
  console.log(`accessory-bag proxy on :${PORT} — key ${KEY ? "configured" : "MISSING"}`);
});
