/* Accessory Power Ledger — shared UI for both targets.
 *
 * Data arrives one of two ways:
 *   inlined  — window.__CATALOGUE__ / window.__PRICES__ (hosted single-file build)
 *   fetched  — data/accessories.json + /api/prices        (local server)
 *
 * Live refresh pulls current BIN listings straight from Coflnet in the browser, so
 * any host that permits outbound fetches gets live Auction House prices. The published
 * Artifact runs under a CSP that blocks every external host, so there the button
 * reports that and the baked snapshot stands.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LS = { owned: "apl:owned", contacts: "apl:contacts", budget: "apl:budget", prices: "apl:prices", seen: "apl:seen", recomb: "apl:recomb", key: "apl:key", progress: "apl:progress", hideLocked: "apl:hideLocked", capacity: "apl:capacity", jacobus: "apl:jacobus", roomOk: "apl:roomOk" };
  const SLAYERS = ["zombie", "spider", "wolf", "enderman", "blaze", "vampire"];
  const TROPHIES = ["FROG", "LAVA"];
  const COFL = "https://sky.coflnet.com/api";
  // Holds the Hypixel key so visitors never need one, and sweeps the whole Auction
  // House server-side because it is ~46 pages of ~2.5 MB.
  const PROXY = "https://skyblock-mp-bag.onrender.com";
  const PRICE_TTL = 30 * 60 * 1000;

  let cat = null;
  let prices = null;

  const state = {
    owned: (() => { const o = load(LS.owned, null); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; })(),
    contacts: Number(load(LS.contacts, 0)) || 0,
    tab: "value",
    search: "",
    bagSearch: "",
    sort: "rate",
    sortDir: 1,
    bagOrder: [],       // frozen while the bag tab is open, so ticking never reorders under the cursor
    liveState: "idle",
    // What the player has unlocked. Absent means "not unlocked", so a gated accessory
    // stays hidden until they say otherwise rather than being recommended on a guess.
    progress: safeProgress(load(LS.progress, null)),
    capacity: Number(load(LS.capacity, 0)) || 0,
    jacobusBought: Number(load(LS.jacobus, 0)) || 0,
    hideLocked: load(LS.hideLocked, true),
  };

  /**
   * localStorage is user-editable and survives across versions, so anything read from it
   * has to be treated as untrusted. A malformed value here used to throw inside wire(),
   * which boot() catches by blanking the whole page — unrecoverable on every reload.
   */
  function safeProgress(v) {
    const p = v && typeof v === "object" ? v : {};
    const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
    return { slayer: obj(p.slayer), hotm: Number(p.hotm) || 0, trophy: obj(p.trophy) };
  }

  /* ---------------- storage ---------------- */

  function load(k, fb) {
    try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; }
  }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }

  /* ---------------- format ---------------- */

  const coins = (n) => {
    if (n == null || !isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  };

  const parseCoins = (s) => {
    const m = String(s).trim().toLowerCase().replace(/[, ]/g, "").match(/^([\d.]+)\s*([kmb])?$/);
    return m ? parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1) : NaN;
  };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const ROUTE = {
    "buy": "buy it",
    "buy-recombobulated": "buy one already recombobulated",
    "buy+recombobulate": "buy it, then recombobulate",
    "recombobulate-owned": "recombobulate the one you own",
  };

  const rarityVar = (r) => `var(--r-${String(r).toLowerCase()}, var(--r-common))`;
  const ago = (ms) => {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    if (s < 172800) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };

  /* ---------------- boot ---------------- */

  /** First URL that returns usable price data, else an empty set. */
  async function firstOf(urls, timeoutMs) {
    for (const u of urls) {
      try {
        // Without this a sleeping free instance holds the whole chain open.
        const r = await fetch(u, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined);
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.lowestBin && Object.keys(j.lowestBin).length) return normalisePrices(j);
      } catch { /* try the next one */ }
    }
    return { generated: 0, lowestBin: {} };
  }

  /**
   * Three price sources with three vocabularies: the proxy sweep, the local server's
   * own sweep (which calls the listing count `scanned`), and the baked snapshot.
   * Normalise here so the stamp does not have to guess, and so a real sweep is never
   * described as a snapshot.
   */
  function normalisePrices(j) {
    if (j.listings == null && j.scanned != null) j.listings = j.scanned;
    if (j.accessories == null && j.lowestBin) {
      j.accessories = new Set(Object.keys(j.lowestBin).map((k) => k.slice(0, k.indexOf("|")))).size;
    }
    if (!j.source && j.pages) j.source = "live";
    return j;
  }

  async function boot() {
    // The catalogue is the one thing nothing works without. A bad deploy or a dropped
    // connection here used to reject silently and leave a permanently inert page.
    try {
      cat = MP.index(window.__CATALOGUE__ || await (await fetch("data/accessories.json")).json());
    } catch (e) {
      console.error("catalogue load failed:", e);
      fatal("Could not load the accessory catalogue, so there is nothing to rank yet. " +
            "Reload the page — if it keeps happening the deploy is probably mid-flight.");
      return;
    }

    // Paint with whatever is already to hand. The full sweep lives on a free instance
    // that sleeps, and waiting for it used to leave the page inert — no tabs, no
    // rankings, dead buttons — for the better part of a minute on the first visit.
    const cached = load(LS.prices, null);
    if (cached && cached.lowestBin && Date.now() - cached.generated < PRICE_TTL) prices = cached;
    else prices = window.__PRICES__ || null;
    if (!prices) prices = await firstOf(["data/prices-snapshot.json"], 8000);

    $("contacts").max = String(cat.rules.abiphoneContactsKnown);
    $("contacts").value = state.contacts;
    $("budget").value = load(LS.budget, "100m");

    try {
      wire();
      stamp();
      render();
    } catch (e) {
      console.error(e);
      fatal("Something went wrong building the page: " + (e && e.message ? e.message : e));
      return;
    }

    upgradePrices();   // deliberately not awaited
  }

  /**
   * Swap in a complete Auction House sweep once one arrives. The page is already
   * usable by now, so a slow or missing source costs nothing but freshness.
   */
  async function upgradePrices() {
    if (window.__PRICES__) return;                       // inlined build: CSP blocks this anyway
    const sources = isLocal() ? ["api/prices", PROXY + "/prices"] : [PROXY + "/prices"];
    const fresh = await firstOf(sources, 70000);         // a sleeping instance takes ~50s to wake
    if (!fresh || !fresh.lowestBin || !Object.keys(fresh.lowestBin).length) return;
    if (prices.generated && fresh.generated <= prices.generated) return;
    prices = fresh;
    save(LS.prices, prices);
    stamp();
    render();
  }

  const isLocal = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  /** Last resort: the page cannot function, so say so where the rankings would be. */
  function fatal(message) {
    const led = $("led"); if (led) led.className = "led stale";
    const stampText = $("stampText"); if (stampText) stampText.textContent = "unavailable";
    for (const id of ["valueList", "maxList", "planList", "earnList", "freeList", "bagList"]) {
      const node = $(id);
      if (!node) continue;
      node.textContent = "";
      const box = el("div", "callout warn");
      box.setAttribute("role", "alert");
      box.append(el("h3", null, "This page could not start"));
      box.append(el("p", null, message));
      node.append(box);
    }
  }

  function stamp() {
    // `variants` counts item x rarity x recombobulated price points, not auctions.
    // Calling that number "listings" read as if the tool had only seen 350-odd
    // auctions, when the sweep actually reads several thousand.
    const variants = Object.keys(prices.lowestBin || {}).length;
    const priced = prices.accessories || new Set(Object.keys(prices.lowestBin || {}).map((k) => k.slice(0, k.indexOf("|")))).size;
    const age = prices.generated ? Date.now() - prices.generated : Infinity;
    const led = $("led");
    led.className = "led" + (state.liveState === "busy" ? " busy" : age > 6 * 3600e3 ? " stale" : "");
    $("stampText").textContent = state.liveState === "busy"
      ? "sweeping the auction house…"
      : `${priced} accessories priced · ${prices.generated ? ago(prices.generated) : "snapshot"}`;

    const tradeable = cat ? cat.accessories.filter((a) => a.tradeable).length : 0;
    const unlisted = tradeable && priced ? tradeable - priced : 0;
    const complete = !prices.expectedPages || !prices.pages || prices.pages >= prices.expectedPages;
    const scope = prices.listings
      ? `Swept ${complete ? "all" : prices.pages + " of"} ${prices.expectedPages || 46} Auction House pages: ${prices.listings.toLocaleString()} buy-it-now accessory listings, ` +
        `collapsed to ${variants} lowest prices across ${priced} accessories` +
        (unlisted > 0 ? `. The other ${unlisted} tradeable accessories have no buy-it-now listing at all right now.` : ".")
      : `${variants} lowest prices across ${priced} accessories.`;

    $("footFresh").textContent = prices.source === "live"
      ? `${scope} Fetched ${ago(prices.generated)}.`
      : `${scope} This is a baked snapshot — hit “Live prices” for the current Auction House, where the host allows it.`;
  }

  /* ---------------- live prices ---------------- */

  async function refreshLive() {
    if (state.liveState === "busy") return;
    const ids = cat.accessories.filter((a) => a.tradeable).map((a) => a.id);
    state.liveState = "busy";
    $("liveBtn").disabled = true;
    $("progress").hidden = false;
    stamp();

    const lowestBin = Object.create(null);
    let done = 0, ok = 0, failed = 0;
    let blocked = false;

    // Coflnet drops connections under sustained parallelism. Measured over all 305
    // accessories: 5-wide got 83 through, 3-wide with two retries got 290 in 18s.
    const CONCURRENCY = 3;
    const RETRIES = 2;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const queue = [...ids];
    const worker = async () => {
      while (queue.length && !blocked) {
        const id = queue.shift();
        let list = null;

        let throttled = false;
        for (let attempt = 0; attempt <= RETRIES && !list; attempt++) {
          // A dropped connection clears in milliseconds; a 429 needs real time, and
          // clicking Live prices twice in a row is enough to earn one.
          if (attempt) await sleep((throttled ? 1500 : 300) * attempt * attempt);
          try {
            // One hung socket otherwise costs a third of the throughput.
            const r = await fetch(`${COFL}/auctions/tag/${id}/active/bin`, { signal: AbortSignal.timeout(8000) });
            throttled = r.status === 429;
            if (r.ok) list = await r.json();
          } catch { /* transient — retry */ }
        }

        if (list) {
          ok++;
          const base = cat.byId[id].rarity;
          for (const a of list) {
            if (a.bin === false) continue;
            // Coflnet reports the listing's effective tier, so a rarity above the item's
            // base rarity is exactly what a recombobulated copy looks like.
            const tier = a.tier || base;
            const recomb = tier !== base ? 1 : 0;
            const key = `${id}|${tier}|${recomb}`;
            const cur = lowestBin[key];
            if (!cur) lowestBin[key] = { price: a.startingBid, count: 1 };
            else { cur.count++; if (a.startingBid < cur.price) cur.price = a.startingBid; }
          }
        } else {
          failed++;
          // A CSP refusal fails every request instantly; stop rather than grind through 305.
          if (failed >= 5 && ok === 0) blocked = true;
        }

        done++;
        const pct = (done / ids.length) * 100;
        $("progressFill").style.width = pct.toFixed(1) + "%";
        $("progress").setAttribute("aria-valuenow", String(Math.round(pct)));
        $("stampText").textContent = `fetching live prices… ${done}/${ids.length}`;
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Recombobulator price keeps the "recombobulate what you own" route honest.
    let recombobulator = prices.recombobulator || null;
    if (!blocked) {
      try {
        const r = await fetch(`${COFL}/item/price/RECOMBOBULATOR_3000/current`);
        if (r.ok) { const j = await r.json(); if (j.buy) recombobulator = { buy: j.buy, sell: j.sell }; }
      } catch { /* keep the snapshot value */ }
    }

    state.liveState = "idle";
    $("liveBtn").disabled = false;
    $("progress").hidden = true;
    $("progressFill").style.width = "0%";

    // A partial sweep is worse than the snapshot it would replace, and caching it would
    // poison the next 30 minutes. Keep what we had unless most of the sweep landed.
    const ratio = ok / ids.length;
    if (blocked || ratio < 0.7) {
      note(blocked
        ? "Could not reach the price service. If you are viewing this as a Claude Artifact, it blocks calls to "
          + "other sites by design — the live site at goofturtles.github.io/skyblock-mp can fetch them. "
          + "Otherwise it may be your connection. Existing prices are unchanged."
        : `Only ${ok} of ${ids.length} accessories came back, so the existing prices were kept rather `
          + "than replaced with a partial set. The price service throttles rapid repeat sweeps — "
          + "give it a minute and try again.", "warn");
      stamp();
      return;
    }

    // Merge over the previous set so ids that failed this round keep their last known price.
    const merged = Object.assign(Object.create(null), prices.lowestBin || {}, lowestBin);
    prices = { generated: Date.now(), source: "live", recombobulator, lowestBin: merged };
    save(LS.prices, prices);
    note(`Live prices in: ${Object.keys(lowestBin).length} listings across ${ok} accessories.`
      + (failed ? ` ${failed} could not be reached and kept their previous price.` : ""), "good");
    stamp();
    render();
  }

  function note(text, kind) {
    const n = $("note");
    n.textContent = text;
    n.className = "callout " + (kind || "");
    n.hidden = false;
    clearTimeout(note._t);
    note._t = setTimeout(() => { n.hidden = true; }, 9000);
  }


  /* ---------------- username lookup ---------------- */

  /**
   * Username -> { uuid (dashless), username }.
   *
   * Three resolvers because one is not enough: ashcon returned 404 for a real account
   * ("goofturtle") that both playerdb and minetools resolve, so a single source will
   * tell some players they do not exist. Mojang's own API sends no CORS header, so a
   * browser cannot use it. Tries each in turn; only reports "not found" when a resolver
   * actually said so, never when they were all merely unreachable.
   */
  async function resolveUuid(name) {
    const sources = [
      {
        url: `https://playerdb.co/api/player/minecraft/${encodeURIComponent(name)}`,
        parse: (j) => j && j.data && j.data.player && j.data.player.raw_id
          ? { uuid: j.data.player.raw_id, username: j.data.player.username } : null,
      },
      {
        url: `https://api.minetools.eu/uuid/${encodeURIComponent(name)}`,
        parse: (j) => j && j.status === "OK" && j.id ? { uuid: j.id, username: j.name || name } : null,
      },
      {
        url: `https://api.ashcon.app/mojang/v2/user/${encodeURIComponent(name)}`,
        parse: (j) => j && j.uuid ? { uuid: String(j.uuid).replace(/-/g, ""), username: j.username || name } : null,
      },
    ];

    let sawDefiniteMiss = false;
    for (const src of sources) {
      try {
        const r = await fetch(src.url, { signal: AbortSignal.timeout(8000) });
        const j = await r.json().catch(() => null);
        const hit = j && src.parse(j);
        if (hit && hit.uuid) return hit;
        // A parsed response that simply has no player is a real answer, not an outage.
        if (j) sawDefiniteMiss = true;
      } catch { /* try the next resolver */ }
    }

    throw new Error(sawDefiniteMiss
      ? `No Minecraft account called “${name}”. Check the spelling — it is your in-game name, not your Discord or GitHub name.`
      : "Could not reach any username lookup service. Check your connection and try again.");
  }


  /**
   * Reads a player's accessory bag and ticks everything in it.
   *
   * Hypixel serves profile contents only to a key holder — there is no keyless route
   * (SkyCrypt's public API is behind a WAF, and the community mirrors that do work strip
   * inventories). SkyCrypt solves this by holding a key on its own server, and so do we:
   * the proxy does the lookup, so a visitor types only a username.
   *
   * If the proxy is unreachable, or someone would rather not go through it, a personal
   * key still works — it stays in this browser and is sent only to api.hypixel.net.
   */
  async function loadProfile() {
    const name = $("username").value.trim();
    if (!name) { note("Type a Minecraft username first.", "warn"); $("username").focus(); return; }
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) { note(`“${name}” is not a valid Minecraft username.`, "warn"); return; }

    $("loadBtn").disabled = true;
    const key = load(LS.key, "");
    try {
      note(`Looking up ${name}…`);
      const bag = key ? await bagViaKey(name, key) : await bagViaProxy(name);

      const owned = {};
      for (const a of bag.accessories) {
        if (!cat.byId[a.id]) continue;
        // Duplicates are common; keep the recombobulated copy, it is the one that counts.
        if (!owned[a.id] || (a.recomb && !owned[a.id].recomb)) owned[a.id] = { recomb: !!a.recomb };
      }
      // Count distinct accessories, not raw items: the proxy already de-duplicates and a
      // personal key does not, so counting items reported two different totals for one bag.
      const matched = Object.keys(owned).length;
      if (!matched) throw new Error(`${bag.username}'s accessory bag came back empty. Check Inventory API is on in SkyBlock (/api → API Settings).`);

      state.owned = owned;
      state.bagOrder = [];
      save(LS.owned, state.owned);
      render();
      const skipped = new Set(bag.accessories.map((a) => a.id)).size - matched;
      note(`Loaded ${matched} accessories from ${bag.username}${bag.profile ? ` (${bag.profile})` : ""}.`
        + (skipped > 0 ? ` ${skipped} items were not power-granting accessories.` : ""), "good");
    } catch (e) {
      note(String((e && e.message) || e), "warn");
    } finally {
      $("loadBtn").disabled = false;
    }
  }

  /** No key needed: the proxy holds one, the way SkyCrypt does. */
  async function bagViaProxy(name) {
    let res;
    try {
      // A cold free instance takes a while to wake, so allow for it rather than
      // failing the first lookup of the day.
      res = await fetch(`${PROXY}/bag?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(60000) });
    } catch {
      throw new Error("Could not reach the lookup service. It may be waking up — try again in a few seconds, "
        + "or add your own Hypixel key under “API key”.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 503) {
        $("keybox").hidden = false;
        throw new Error("The lookup service has no Hypixel key configured yet. Add your own under “API key” in the meantime.");
      }
      throw new Error(data.error || `Lookup failed (HTTP ${res.status}).`);
    }
    return data;
  }

  /** Fallback path: this browser's own key, sent only to Hypixel. */
  async function bagViaKey(name, key) {
    const { uuid: flat, username } = await resolveUuid(name);
    note(`Fetching ${username}'s SkyBlock profiles…`);
    let res;
    try {
      res = await fetch(`https://api.hypixel.net/v2/skyblock/profiles?uuid=${flat}`, { headers: { "API-Key": key } });
    } catch {
      throw new Error("Could not reach Hypixel with your key. Check your connection, or clear the key to use the built-in lookup instead.");
    }
    const data = await res.json().catch(() => ({}));
    if (!data.success) {
      throw new Error(data.cause === "Invalid API key"
        ? "Hypixel rejected that API key. Check it under “API key”."
        : (data.cause || `Hypixel returned HTTP ${res.status}.`));
    }
    if (!data.profiles || !data.profiles.length) throw new Error(`${username} has no SkyBlock profiles.`);

    const profile = data.profiles.find((p) => p.selected) || data.profiles[0];
    const member = profile.members && profile.members[flat];
    if (!member) throw new Error("That profile holds no data for this player.");

    const blob = (member.inventory && member.inventory.bag_contents && member.inventory.bag_contents.talisman_bag && member.inventory.bag_contents.talisman_bag.data)
      || (member.talisman_bag && member.talisman_bag.data)
      || (typeof member.talisman_bag === "string" ? member.talisman_bag : null);
    if (!blob) throw new Error(`${username}'s accessory bag is hidden. In SkyBlock run /api and switch Inventory API on, then try again.`);

    const items = await NBT.decodeItems(blob);
    const accessories = [];
    for (const it of items) {
      const extra = it && it.tag && it.tag.ExtraAttributes;
      if (extra && extra.id) accessories.push({ id: extra.id, recomb: !!extra.rarity_upgrades });
    }
    return { username, profile: profile.cute_name, accessories };
  }

  /* ---------------- derive ---------------- */

  function derive() {
    const opts = {
      contacts: state.contacts, includeRecomb: $("useRecomb").checked, progress: state.progress,
      capacity: state.capacity, jacobusBought: state.jacobusBought,
    };
    const evalNow = MP.evaluate(cat, state.owned, opts);
    const all = MP.offers(cat, state.owned, prices, opts);
    return { opts, evalNow, all, maxTier: MP.maxTierOffers(all), earn: MP.earnable(cat, state.owned, prices, opts) };
  }

  function ceiling(opts) {
    let total = 0;
    for (const fam of Object.values(cat.families)) {
      total += Math.max(...fam.members.map((id) => {
        const a = cat.byId[id];
        return MP.powerOf(cat, a, opts.includeRecomb && a.recombable, state.contacts);
      }));
    }
    return total;
  }

  const SORTS = {
    rate: (a, b) => a.coinsPerMp - b.coinsPerMp,
    cost: (a, b) => a.cost - b.cost,
    gain: (a, b) => b.gain - a.gain,
    name: (a, b) => a.name.localeCompare(b.name),
  };

  function applyView(list) {
    const q = state.search.trim().toLowerCase();
    // A locked accessory cannot be bought, so by default it is not a recommendation.
    const reachable = state.hideLocked ? list.filter((o) => !o.locked) : list;
    let out = q ? reachable.filter((o) => o.name.toLowerCase().includes(q) || o.familyName.toLowerCase().includes(q)) : reachable.slice();
    out.sort(SORTS[state.sort] || SORTS.rate);
    if (state.sortDir < 0) out.reverse();
    return out;
  }

  /* ---------------- rows ---------------- */

  function header(target, scope) {
    const h = el("div", "lhead");
    h.setAttribute("role", "row");
    const idx = el("span", "h-idx");
    idx.setAttribute("role", "columnheader");
    h.append(idx);
    const cols = [["name", "Accessory", "h-name"], ["gain", "Power", "h-power"], ["cost", "Price", ""], ["rate", "Per AP", "h-rate"]];
    for (const [key, label, cls] of cols) {
      const b = el("button", cls);
      b.type = "button";
      b.setAttribute("role", "columnheader");
      // Both the Best value and Max tier panels build a header, so the key has to name
      // its panel. Sharing one key sent focus to whichever button the query found first,
      // which is the hidden panel's — so sorting silently dropped focus to <body>.
      b.dataset.focusKey = `sort:${scope}:${key}`;
      b.append(document.createTextNode(label));
      const active = state.sort === key;
      // `gain` sorts high-to-low at dir 1, the others low-to-high; the glyph has to follow
      // the data, not the flag.
      const descending = active && ((key === "gain") === (state.sortDir > 0));
      b.setAttribute("aria-sort", active ? (descending ? "descending" : "ascending") : "none");
      if (active) {
        const arrow = el("span", "arrow", descending ? "▼" : "▲");
        arrow.setAttribute("aria-hidden", "true");   // the .sr span below says it in words
        b.append(arrow);
        b.append(el("span", "sr", descending ? ", sorted descending" : ", sorted ascending"));
      }
      b.addEventListener("click", () => {
        if (state.sort === key) state.sortDir *= -1;
        else { state.sort = key; state.sortDir = 1; }
        render();
      });
      h.append(b);
    }
    target.append(h);
  }

  /**
   * Name + rarity, coloured the way the game colours item names. The rarity word
   * stays as a dim label so the tier is still readable to anyone who does not have
   * the colour scale memorised (and to screen readers, which get no colour at all).
   */
  /** A numeric cell that tells a screen reader which column it is in. */
  function cell(cls, text, label) {
    const c = el("div", cls, text);
    c.setAttribute("role", "cell");
    if (label) c.setAttribute("aria-label", `${label}: ${text}`);
    return c;
  }

  function nameAndRarity(line1, name, rarity, opts) {
    const n = el("span", "iname", name);
    n.style.color = rarityVar(rarity);
    line1.append(n);
    // Lowercase in the DOM and uppercased visually by CSS: screen readers spell out
    // all-caps words letter by letter.
    line1.append(el("span", "rarity", String(rarity).replace("_", " ").toLowerCase()));
    if (opts && opts.recomb) line1.append(el("span", "chip recomb", "recombobulated"));
    return line1;
  }

  function entry(o, i) {
    const row = el("div", "entry" + (o.locked ? " locked" : ""));
    row.setAttribute("role", "row");
    const idx = el("div", "idx", i == null ? "" : String(i + 1));
    idx.setAttribute("role", "cell");
    row.append(idx);

    const body = el("div", "body");
    body.setAttribute("role", "cell");
    const l1 = nameAndRarity(el("div", "line1"), o.name, o.rarity, { recomb: o.recomb });
    if (o.locked) l1.append(el("span", "chip locked", "needs " + o.needs.join(" + ")));
    if (o.familyName && o.familyName !== o.name) l1.append(el("span", "line-of", o.familyName + " line"));
    body.append(l1);

    const l2 = el("div", "line2");
    l2.append(el("span", null, ROUTE[o.route] || o.route));
    if (o.fromMp > 0) { l2.append(el("span", "sep", "·")); l2.append(el("span", null, `${o.fromMp} → ${o.toMp} in this line`)); }
    // The list shows one row per family, so say when the family climbs higher than this
    // rung — otherwise collapsing hides the ceiling.
    if (o.familyTopMp && o.familyTopMp > o.toMp) {
      l2.append(el("span", "sep", "·"));
      l2.append(el("span", null, `line goes to ${o.familyTopMp} AP`));
    }
    if (o.listings) { l2.append(el("span", "sep", "·")); l2.append(el("span", null, `${o.listings} listed`)); }
    // Narrow screens drop the Power column so coins-per-AP can stay; keep the number here.
    l2.append(el("span", "sep m-only", "·"));
    l2.append(el("span", "m-gain", `+${o.gain} AP`));
    body.append(l2);
    row.append(body);

    row.append(cell("num c-power", "+" + o.gain, "power gained"));
    row.append(cell("num c-price", coins(o.cost), "price"));
    const rate = cell("num c-rate", coins(o.coinsPerMp), "coins per power");
    rate.append(el("span", "unit", "/AP"));
    row.append(rate);
    return row;
  }

  /** Rows are divs, so the table structure has to be declared for assistive tech. */
  function asTable(node) {
    node.setAttribute("role", "table");
    return node;
  }


  function fill(node, list, make, emptyText) {
    // The sortable header now lives inside the table, so clearing must not remove it.
    for (const child of [...node.children]) if (!child.classList.contains("lhead")) child.remove();
    if (!list.length) { node.append(el("div", "empty", emptyText)); return; }
    list.forEach((x, i) => node.append(make(x, i)));
  }

  /* ---------------- render ---------------- */

  const CAP = 150;

  // Which renderer owns each panel. Building all six on every keystroke meant ~6,000
  // nodes per character typed, most of them into panels nobody was looking at.
  const PANELS = {
    value: (d) => renderValue(d),
    max: (d) => renderMax(d),
    plan: (d) => renderPlan(d),
    earn: (d) => renderEarn(d),
    free: (d) => renderFree(d),
    slots: (d) => renderSlots(d),
    bag: () => renderBag(),
  };

  let renderedTab = null;

  function render() {
    // Full re-render nukes focus; put it back where the keyboard user left it.
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.focusKey : null;

    const d = derive();
    renderStrip(d);
    renderCounts(d);       // cheap, and the tab labels must stay honest
    renderOnboard(d);
    (PANELS[state.tab] || PANELS.value)(d);
    renderedTab = state.tab;

    if (focusKey) {
      const back = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (back) back.focus({ preventScroll: true });
    }
  }

  function renderCounts(d) {
    const set = (tab, n) => { const e = document.querySelector(`.tab[data-tab="${tab}"] .count`); if (e) e.textContent = n; };
    // The value tab shows one row per family, so its label must count families, not offers.
    const capNow = MP.capacityPlan(cat, state.owned, prices, { ...d.opts, hideLocked: state.hideLocked, assumeFull: !load(LS.roomOk, false) });
    set("value", capNow.full
      ? MP.bestPerFamily(capNow.upgrades).length + capNow.swaps.length
      : MP.bestPerFamily(d.all).filter((o) => !state.hideLocked || !o.locked).length);
    set("max", d.maxTier.filter((o) => !state.hideLocked || !o.locked).length);
    set("earn", d.earn.length);
    set("bag", Object.keys(state.owned).length);
    set("slots", MP.slotPlan(cat, state.owned, prices, d.opts).freed || "");
  }

  function renderStrip({ evalNow, opts }) {
    const max = ceiling(opts);
    const held = Object.keys(state.owned).length;
    $("ap").textContent = evalNow.total.toLocaleString();
    $("apSub").textContent = held ? `${evalNow.families.length} families contributing` : "tick what you own to personalise";
    $("mult").textContent = "×" + evalNow.multiplier.toFixed(2);
    $("held").textContent = held.toLocaleString();
    $("heldSub").textContent = `of ${cat.accessories.length} in the game`;
    $("headroom").textContent = Math.max(0, max - evalNow.total).toLocaleString();
    $("headroomSub").textContent = `ceiling ${max.toLocaleString()} AP`;
    $("meter").style.width = (max ? Math.min(100, (evalNow.total / max) * 100) : 0).toFixed(1) + "%";
  }

  function renderOnboard({ evalNow }) {
    const box = $("onboard");
    const dismissed = load(LS.seen, false);
    box.hidden = dismissed || Object.keys(state.owned).length > 0;
  }

  function renderValue(d) {
    const { all } = d;
    const node = $("valueList");
    node.textContent = "";

    // Telling someone to buy more when the bag is full is useless advice — nothing can
    // go in until something comes out. Say so, and change what is being recommended.
    const cap = MP.capacityPlan(cat, state.owned, prices, { ...d.opts, hideLocked: state.hideLocked, assumeFull: !load(LS.roomOk, false) });
    if (cap.full) { renderFullBag(node, cap, cap.assumed); return; }

    // The page already knows how many accessories are held, so making someone count
    // slots by hand is asking for a number it can work out. An untouched slot count is
    // therefore assumed to equal what is held — the common case is a full bag, and that
    // is also the case where wrong advice actually costs something. Said out loud, and
    // overridden by typing a real number.
    if (cap.assumed) {
      const note = el("div", "callout");
      note.append(el("h3", null, `Assuming ${cap.capacity} slots, because that is what you hold`));
      const p = el("p", null,
        "If your bag has spare room, put the real number in Bag slots and this goes back to a plain buy list. ");
      const b = el("button", "linkish", "I have room to spare");
      b.type = "button";
      b.addEventListener("click", () => { save(LS.roomOk, true); render(); });
      p.append(b);
      note.append(p);
      node.append(note);
    }

    // Dead weight is the loudest thing the page can say to someone with a packed bag:
    // free slots they already own. Saying nothing and listing purchases buries it.
    if (cap.capacity && cap.dead.length) {
      const c = el("div", "callout good");
      c.append(el("h3", null,
        `${cap.dead.length} of your ${cap.held} accessories are contributing nothing`));
      const p = el("p", null,
        `They are outranked inside their own families, so removing them costs no power and frees `
        + `${cap.dead.length} slot${cap.dead.length === 1 ? "" : "s"} you already own. `);
      const b = el("button", "linkish", "See what to take out");
      b.type = "button";
      b.addEventListener("click", () => selectTab("slots"));
      p.append(b);
      c.append(p);
      node.append(c);
    }

    if (cap.capacity && cap.free <= 2 && !cap.dead.length) {
      const warn = el("div", "callout warn");
      warn.append(el("h3", null, `${cap.free} slot${cap.free === 1 ? "" : "s"} left of ${cap.capacity}`));
      warn.append(el("p", null, "Once it is full this list switches to swaps — what to take out for what."));
      node.append(warn);
    }
    // One row per family: offers() emits a row per reachable tier, and listing both the
    // Ring and the Artifact above it reads as "buy both" when you would only ever buy one.
    // Collapse AFTER dropping what the player cannot get: choosing the best rate across
    // locked offers and then filtering the winner away deleted the family entirely, hiding
    // a purchasable upgrade underneath it.
    const reachable = state.hideLocked ? all.filter((o) => !o.locked) : all;
    const view = applyView(MP.bestPerFamily(reachable));
    const body = asTable(el("div", "ledger"));
    header(body, "value");
    fill(body, view.slice(0, CAP), entry,
      state.search ? "No upgrade matches that search." : "Nothing left to buy — every purchasable family is at its best tier.");
    node.append(body);
    if (view.length > CAP) node.append(el("div", "empty", `Showing ${CAP} of ${view.length}. Narrow it with the search box.`));
    // Hiding things you cannot get is only helpful if you know it is happening.
    lockedNote(node, state.hideLocked ? MP.bestPerFamily(all).filter((o) => o.locked).length : 0);
  }

  function renderMax({ maxTier }) {
    const node = $("maxList");
    node.textContent = "";
    const view = applyView(maxTier);
    if (view.length) {
      const total = view.reduce((n, o) => n + o.cost, 0);
      const gain = view.reduce((n, o) => n + o.gain, 0);
      const head = el("div", "callout good");
      head.append(el("h3", null, `All ${view.length} top tiers: ${coins(total)} for ${gain.toLocaleString()} AP`));
      head.append(el("p", null, "Every family at the highest tier currently listed. The rest of the ceiling is locked behind things coins cannot buy — see “Can’t buy”."));
      node.append(head, el("div", "note"));
    }
    const body = asTable(el("div", "ledger"));
    header(body, "max");
    fill(body, view, entry, "Every purchasable family is already maxed.");
    node.append(body);
  }

  function renderPlan({ all, evalNow }) {
    const buyable = state.hideLocked ? all.filter((o) => !o.locked) : all;
    const budget = parseCoins($("budget").value);
    const sum = $("planSummary");
    sum.textContent = "";
    if (!isFinite(budget)) {
      sum.append(el("div", "empty", "Enter a budget like 250m or 1.5b."));
      $("planList").textContent = "";
      return;
    }
    const s = MP.solveBudget(buyable, budget);
    const after = evalNow.total + s.gain;
    const cell = (label, value, sub) => {
      const c = el("div", "cell");
      c.append(el("div", "cell-label", label), el("div", "cell-value", value), el("div", "cell-sub", sub));
      return c;
    };
    sum.append(cell("Budget", coins(budget), `${s.picks.length} purchases fit`));
    sum.append(cell("Spends", coins(s.spend), coins(budget - s.spend) + " left over"));
    sum.append(cell("Power gained", "+" + s.gain.toLocaleString(), s.gain ? coins(s.spend / s.gain) + " per AP" : "—"));
    sum.append(cell("Ends at", after.toLocaleString() + " AP", `×${MP.multiplier(after).toFixed(2)} from ×${evalNow.multiplier.toFixed(2)}`));

    const node = $("planList");
    node.textContent = "";
    const body = asTable(el("div", "ledger"));
    // No sort header here: the plan is an ordered shopping list, and re-sorting it would
    // imply the order is arbitrary when it is the solver's output.
    fill(body, s.picks, entry, "Nothing fits that budget — the cheapest upgrade costs more.");
    node.append(body);
  }

  function renderEarn({ earn }) {
    fill(asTable($("earnList")), earn, (e, i) => {
      const row = el("div", "entry");
    row.setAttribute("role", "row");
      const idxE = el("div", "idx", String(i + 1));
      idxE.setAttribute("role", "cell");
      row.append(idxE);
      const body = el("div", "body");
      body.setAttribute("role", "cell");
      const l1 = nameAndRarity(el("div", "line1"), e.name, e.rarity);
      if (e.rift) l1.append(el("span", "chip rift", "rift"));
      if (e.soulbound) l1.append(el("span", "chip soul", "soulbound " + String(e.soulbound).toLowerCase()));
      if (e.dungeon) l1.append(el("span", "chip dungeon", "dungeon"));
      if (e.locked) l1.append(el("span", "chip locked", "needs " + e.needs.join(" + ")));
      body.append(l1, el("div", "line2", "no auction listings — has to be earned"));
      row.append(body);
      row.append(el("div", "num c-power", "+" + e.gain));
      row.append(el("div", "num c-price", "free"));
      row.append(el("div", "num c-rate", "—"));
      return row;
    }, "Nothing here.");
  }

  function renderFree({ evalNow, all }) {
    const node = $("freeList");
    node.textContent = "";
    const tips = [];
    const known = cat.rules.abiphoneContactsKnown;

    if (state.owned.ABICASE) {
      const now = Math.floor(state.contacts / 2);
      const room = Math.floor(known / 2) - now;
      if (room > 0) tips.push(["good", "Add Abiphone contacts — the cheapest power there is",
        `Your Abicase turns every 2 contacts into 1 Accessory Power. At ${state.contacts} contacts you get +${now} AP. `
        + `There are ${known} contacts in the game, so ${room} more AP is sitting there for the price of a few conversations.`]);
    } else {
      tips.push(["", "Get an Abicase",
        `The strongest single accessory for power: 8 from its rarity plus 1 per 2 Abiphone contacts — about +${Math.floor(known / 2)} more once stocked.`]);
    }

    if (!state.owned.RIFT_PRISM) tips.push(["", "Imbue the Rift Prism (+11 AP)",
      "A flat 11 Accessory Power once imbued at Erihann in the Rift — more than a Legendary accessory, and an errand rather than a purchase."]);

    const wasted = evalNow.families.filter((f) => f.wasted.length);
    if (wasted.length) {
      const n = wasted.reduce((a, f) => a + f.wasted.length, 0);
      tips.push(["warn", n === 1 ? "1 accessory in your bag is contributing nothing" : `${n} accessories in your bag are contributing nothing`,
        "Only the highest-power accessory in each line counts, so these are dead weight you could sell: "
        + wasted.slice(0, 8).map((f) => f.wasted.map((id) => cat.byId[id].name).join(", ")).join("; ") + (wasted.length > 8 ? ", and more." : ".")]);
    }

    if (state.owned.CRUX_TALISMAN_7 || state.owned.CRUX_TALISMAN_6) tips.push(["warn", "Do not upgrade the Crux line past the Chronomicon",
      "The Celestial Starstone tops the Crux tree and grants no Accessory Power at all. The Crux Chronomicon below it gives 22, so the “upgrade” costs you 22 AP."
      + (state.owned.CRUX_TALISMAN_7 && !state.owned.CRUX_TALISMAN_6 ? " You hold the Starstone right now and get nothing from that line." : "")]);

    const recombs = all.filter((o) => o.route === "recombobulate-owned");
    if (recombs.length && prices.recombobulator) {
      const best = recombs.slice().sort((a, b) => a.coinsPerMp - b.coinsPerMp)[0];
      tips.push(["", "Recombobulate what is already in your bag",
        `A Recombobulator 3000 runs about ${coins(prices.recombobulator.buy)} and lifts one accessory a full rarity. `
        + `Best candidate: ${best.name}, +${best.gain} AP for ${coins(best.cost)}. ${recombs.length} of your accessories could take one.`]);
    }

    tips.push(["", "Dungeon accessories count double in dungeons",
      "Anything flagged as a dungeon item contributes twice its power inside the Catacombs. Every figure here is overworld power, the conservative number."]);

    for (const [kind, head, text] of tips) {
      const c = el("div", "callout" + (kind ? " " + kind : ""));
      c.append(el("h3", null, head), el("p", null, text));
      node.append(c);
    }
  }

  function bagList() {
    const q = state.bagSearch.trim().toLowerCase();
    // Order is frozen per tab-entry so ticking a box never moves rows under the pointer.
    if (!state.bagOrder.length) {
      state.bagOrder = cat.accessories.slice()
        .sort((a, b) => (state.owned[b.id] ? 1 : 0) - (state.owned[a.id] ? 1 : 0) || a.name.localeCompare(b.name))
        .map((a) => a.id);
    }
    const list = state.bagOrder.map((id) => cat.byId[id]).filter(Boolean);
    return q ? list.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : list;
  }

  const BAG_CAP = 300;

  /**
   * A full bag changes the question from "what should I buy" to "what should I trade".
   * Three answers, in the order they are worth doing: reclaim slots that are already
   * wasted, take the upgrades that cost no slot at all, then either swap out your weakest
   * or pay Jacobus to stop having to.
   */
  function renderFullBag(node, cap, assumed) {
    const head = el("div", "callout warn");
    head.append(el("h3", null, cap.held > cap.capacity
      ? `Your bag is over its stated size — ${cap.held} accessories in ${cap.capacity} slots`
      : `Your bag is full — ${cap.held} of ${cap.capacity} slots`));
    head.append(el("p", null,
      "Nothing new fits until something comes out, so this is what to trade rather than what to add."));
    if (assumed) {
      const p = el("p", null, "Slot count assumed from what you hold. ");
      const b = el("button", "linkish", "I have room to spare");
      b.type = "button";
      b.addEventListener("click", () => { save(LS.roomOk, true); render(); });
      p.append(b);
      head.append(p);
    }
    node.append(head);

    if (cap.dead.length) {
      const c = el("div", "callout good");
      c.append(el("h3", null, `${cap.dead.length} slot${cap.dead.length === 1 ? "" : "s"} you can reclaim for free`));
      c.append(el("p", null,
        `${cap.dead.map((x) => x.name).join(", ")} — outranked inside ${cap.dead.length === 1 ? "its" : "their"} own family, so removing ${cap.dead.length === 1 ? "it" : "them"} costs no power. See the Slots tab.`));
      node.append(c);
    }

    // Paying Jacobus keeps the whole accessory instead of only the difference over what
    // it displaced. Worth it exactly when that saved power is cheaper bought than lost.
    if (cap.slotBuy) {
      const sb = cap.slotBuy;
      const c = el("div", "callout" + (sb.worthIt ? " good" : ""));
      c.append(el("h3", null, sb.worthIt
        ? `Buy ${sb.slots} more slots from Jacobus — ${coins(sb.cost)}`
        : `Buying slots from Jacobus is not worth it yet`));
      c.append(el("p", null, sb.worthIt
        ? `Upgrade ${sb.upgrade} costs ${coins(sb.cost)} for ${sb.slots} slots. Filling them with ${sb.fills.map((f) => f.name).join(" and ")} `
          + `gains ${sb.gain} AP for ${coins(sb.totalCost)} all in — ${coins(sb.coinsPerMp)} per point. Swapping instead would net only `
          + `${sb.swapGain} AP, because you throw away the ${sb.keptAP} AP you displace.`
        : `Upgrade ${sb.upgrade} costs ${coins(sb.cost)} for ${sb.slots} slots (${coins(sb.coinsPerMp)} per point all in). `
          + `Swapping your weakest out is cheaper at ${coins(sb.swapCoinsPerMp)} per point, because what you would displace is not worth much.`));
      node.append(c);
    }

    if (cap.upgrades.length) {
      const upCount = MP.bestPerFamily(cap.upgrades).length;
      node.append(el("h2", "slot-head", `Upgrades that cost no slot (${upCount})`));
      const sub = el("p", "note", "A higher tier of a family you already hold — the old one comes out as the new one goes in.");
      node.append(sub);
      const t = asTable(el("div", "ledger"));
      header(t, "upgrades");
      // One row per family here too. Listing the Ring and the Artifact above it reads as
      // "buy both" when buying the Ring first is money wasted if the Artifact is the target.
      const upView = applyView(MP.bestPerFamily(cap.upgrades));
      fill(t, upView.slice(0, CAP), entry, state.search ? "No upgrade matches that search." : "");
      node.append(t);
      truncationNote(node, upView.length);
    }

    const swapsView = state.search ? applyView(cap.swaps) : cap.swaps;
    node.append(el("h2", "slot-head", `Swaps worth making (${swapsView.length})`));
    node.append(el("p", "note", "Each takes out your weakest accessory to make room. Ranked by coins per point of net gain, after what you give up."));
    const swapTable = asTable(el("div", "ledger"));
    header(swapTable, "swaps");
    fill(swapTable, swapsView.slice(0, CAP), (sw, i) => {
      const row = entry(sw, i);
      row.classList.add("swap");
      const l2 = row.querySelector(".line2");
      if (l2) {
        l2.textContent = "";
        const out = el("span", "swap-out", `out: ${sw.replaces.name} (${sw.replaces.mp} AP)`);
        const inn = el("span", "swap-in", `in: ${sw.name} (${sw.toMp} AP)`);
        l2.append(out, el("span", "sep", "→"), inn, el("span", "sep", "·"),
          el("span", "gain", `net +${sw.netGain} AP`));
      }
      // The headline number must be the net gain, not the raw one, or the ranking lies —
      // and the accessible name is set when the cell is built, so overwriting only the
      // text would leave a screen reader announcing the pre-swap figure.
      const rate = row.querySelector(".c-rate");
      if (rate) {
        rate.textContent = coins(sw.coinsPerNet);
        rate.setAttribute("aria-label", `coins per net power: ${coins(sw.coinsPerNet)}`);
        rate.append(el("span", "unit", "/AP"));
      }
      const power = row.querySelector(".c-power");
      if (power) {
        power.textContent = "+" + sw.netGain;
        power.setAttribute("aria-label", `net power gained after the swap: +${sw.netGain}`);
      }
      return row;
    }, state.search ? "No swap matches that search." : "No swap is worth it — everything you could buy is weaker than what you would have to remove.");
    node.append(swapTable);
    truncationNote(node, swapsView.length);
    lockedNote(node, cap.hiddenLocked);
  }

  /** Says when a list has been cut short, rather than letting it look complete. */
  function truncationNote(node, total) {
    if (total > CAP) node.append(el("div", "empty", `Showing ${CAP} of ${total}. Narrow it with the search box.`));
  }

  /** Says when rows are being withheld because the player cannot get them. */
  function lockedNote(node, hidden) {
    if (!hidden) return;
    const n = node.appendChild(el("div", "empty",
      `${hidden} more ${hidden === 1 ? "accessory is" : "accessories are"} hidden because you cannot get them yet — `));
    const b = el("button", "linkish", "show them anyway");
    b.type = "button";
    b.addEventListener("click", () => { $("hideLocked").checked = false; state.hideLocked = false; save(LS.hideLocked, false); render(); });
    n.append(b);
  }

  /**
   * The bag has a fixed number of slots, so an accessory that loses to a higher tier in
   * its own family is not merely useless — it is occupying space something else could use.
   */
  function renderSlots(d) {
    const plan = MP.slotPlan(cat, state.owned, prices, d.opts);
    const sum = $("slotSummary");
    sum.textContent = "";

    const cellOf = (label, value, sub) => {
      const c = el("div", "cell");
      c.append(el("div", "cell-label", label));
      c.append(el("div", "cell-value", value));
      c.append(el("div", "cell-sub", sub));
      return c;
    };
    sum.append(cellOf("Accessories held", String(plan.held), "each one takes a slot"));
    sum.append(cellOf("Doing nothing", String(plan.freed),
      plan.freed ? `worth ${plan.deadPower} AP between them` : "nothing wasted"));
    sum.append(cellOf("Refilling them", plan.gain ? "+" + plan.gain + " AP" : "—",
      plan.gain ? coins(plan.spend) + " for the lot" : "no slots to fill"));
    sum.append(cellOf("Power after", String(d.evalNow.total + plan.gain), `from ${d.evalNow.total} today`));

    const deadNode = $("slotDead");
    const fillsNode = $("slotFills");
    deadNode.textContent = "";
    fillsNode.textContent = "";

    if (!Object.keys(state.owned).length) {
      deadNode.append(el("div", "empty", "Tick what you own in My bag, and this shows which of them are wasting a slot."));
      return;
    }
    if (!plan.dead.length) {
      deadNode.append(el("div", "empty", "Nothing in your bag is being outranked — every accessory you hold is pulling its weight."));
      return;
    }

    const h1 = el("h3", "slot-head", `Take these out (${plan.freed})`);
    h1.append(el("span", "sub", "each holds a slot and adds nothing you are not already getting"));
    deadNode.append(h1);

    const deadList = asTable(el("div", "ledger"));
    fill(deadList, plan.dead, (dw) => {
      const row = el("div", "entry");
      row.setAttribute("role", "row");
      const idx0 = el("div", "idx", "");
      idx0.setAttribute("role", "cell");
      row.append(idx0);
      const body = el("div", "body");
      body.setAttribute("role", "cell");
      body.append(nameAndRarity(el("div", "line1"), dw.name, dw.rarity));
      body.append(el("div", "line2", dw.beatenBy
        ? `outranked by your ${dw.beatenBy} (${dw.beatenByMp} AP) in the ${dw.familyName} line`
        : "grants no accessory power at all"));
      row.append(body);
      row.append(cell("num c-power", `${dw.mp} AP`, "idle power, contributing nothing"));
      row.append(cell("num c-price", "—", null));
      const r = cell("num c-rate", "wasted", "status");
      r.classList.add("dead-mark");
      row.append(r);
      return row;
    }, "");
    deadNode.append(deadList);

    if (plan.fills.length) {
      const h2 = el("h3", "slot-head", `Put these in instead (${plan.fills.length})`);
      h2.append(el("span", "sub", "the most power those slots can hold, from what you can actually get"));
      fillsNode.append(h2);
      const fillList = asTable(el("div", "ledger"));
      fill(fillList, plan.fills, entry, "");
      fillsNode.append(fillList);
    }
  }

  function renderBag() {
    const list = bagList();
    const shown = Math.min(list.length, BAG_CAP);
    $("bagCount").textContent = `${Object.keys(state.owned).length} owned · showing ${shown} of ${list.length}`;

    fill(asTable($("bagList")), list.slice(0, BAG_CAP), (a) => {
      const has = state.owned[a.id];
      const row = el("div", "entry pick" + (has ? " own" : ""));
      row.setAttribute("role", "row");

      // Wrapped in a label so the tap target is 30px, not the checkbox's 17px — this is
      // the primary interaction and most of it happens on a phone.
      const hit = el("label", "own-hit");
      const box = el("input", "own-box");
      box.type = "checkbox";
      box.checked = !!has;
      box.dataset.focusKey = "own:" + a.id;
      box.setAttribute("aria-label", "I own " + a.name);
      box.addEventListener("change", () => {
        if (box.checked) state.owned[a.id] = { recomb: false };
        else delete state.owned[a.id];
        save(LS.owned, state.owned);
        render();
      });
      hit.append(box);
      row.append(hit);

      const body = el("div", "body");
      const l1 = nameAndRarity(el("div", "line1"), a.name, a.rarity);
      if (a.rift) l1.append(el("span", "chip rift", "rift"));
      if (a.soulbound) l1.append(el("span", "chip soul", "soulbound"));
      // Dungeon items count double inside the Catacombs, which is worth knowing while
      // ticking a bag — the earn list already flagged them and this one did not.
      if (a.dungeon) l1.append(el("span", "chip dungeon", "dungeon"));
      body.append(l1);

      const fam = cat.families[a.family];
      const l2 = el("div", "line2");
      l2.append(el("span", null, `${MP.powerOf(cat, a, has && has.recomb, state.contacts)} AP`));
      if (fam && fam.members.length > 1) { l2.append(el("span", "sep", "·")); l2.append(el("span", null, `${fam.name} line, ${fam.members.length} tiers`)); }
      body.append(l2);
      row.append(body);

      if (has && a.recombable) {
        const lab = el("label", "recomb-tick");
        lab.title = "Recombobulated";
        const t = el("input");
        t.type = "checkbox";
        t.checked = !!has.recomb;
        t.dataset.focusKey = "recomb:" + a.id;
        t.setAttribute("aria-label", a.name + " is recombobulated");
        t.addEventListener("change", () => {
          state.owned[a.id] = { recomb: t.checked };
          save(LS.owned, state.owned);
          render();
        });
        lab.append(t, el("span", null, "recomb"));
        row.append(lab);
      } else {
        row.append(el("div"));
      }
      return row;
    }, "No accessory matches that search.");

    // Silent truncation would hide 123 accessories and look like they do not exist.
    if (list.length > BAG_CAP) {
      $("bagList").append(el("div", "empty",
        `${list.length - BAG_CAP} more not shown — search by name to reach them.`));
    }
  }

  /* ---------------- tabs ---------------- */

  const TABS = ["value", "max", "plan", "earn", "free", "slots", "bag"];

  function selectTab(name) {
    state.tab = name;
    if (name === "bag") state.bagOrder = [];   // re-sort only on entry
    for (const t of document.querySelectorAll(".tab")) {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of document.querySelectorAll('[role="tabpanel"]')) p.hidden = p.id !== "panel-" + name;
    $("searchWrap").hidden = !(name === "value" || name === "max");
    // Only the active panel is kept current, so the one being opened may be stale.
    if (name !== renderedTab) render();
  }

  /** Coalesces a burst of keystrokes into one render. */
  function debounce(fn, ms) {
    let t = 0;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function wire() {
    const tabs = $("tabs");
    tabs.addEventListener("click", (e) => {
      const t = e.target.closest(".tab");
      if (t) selectTab(t.dataset.tab);
    });
    // Roving tabindex: role="tab" promises arrow-key navigation, so implement it.
    tabs.addEventListener("keydown", (e) => {
      const i = TABS.indexOf(state.tab);
      let next = null;
      if (e.key === "ArrowRight") next = TABS[(i + 1) % TABS.length];
      else if (e.key === "ArrowLeft") next = TABS[(i - 1 + TABS.length) % TABS.length];
      else if (e.key === "Home") next = TABS[0];
      else if (e.key === "End") next = TABS[TABS.length - 1];
      if (!next) return;
      e.preventDefault();
      selectTab(next);
      document.querySelector(`.tab[data-tab="${next}"]`).focus();
    });

    const renderSoon = debounce(render, 120);
    $("budget").addEventListener("input", () => { save(LS.budget, $("budget").value); renderSoon(); });
    $("contacts").addEventListener("input", () => {
      const max = cat.rules.abiphoneContactsKnown;
      const raw = Number($("contacts").value) || 0;
      state.contacts = Math.min(max, Math.max(0, raw));   // unclamped input would poison every ranking
      if (raw > max) $("contacts").value = state.contacts;
      save(LS.contacts, state.contacts);
      render();
    });
    $("useRecomb").checked = load(LS.recomb, true);
    $("useRecomb").addEventListener("change", () => { save(LS.recomb, $("useRecomb").checked); render(); });
    for (const [id, key, set] of [
      ["capacity", LS.capacity, (v) => { state.capacity = v; }],
      ["jacobus", LS.jacobus, (v) => { state.jacobusBought = v; }],
    ]) {
      const input = $(id);
      input.value = String(id === "capacity" ? state.capacity : state.jacobusBought);
      input.addEventListener("input", () => {
        const max = Number(input.max) || Infinity;
        const v = Math.min(max, Math.max(0, Number(input.value) || 0));
        if (String(v) !== input.value) input.value = String(v);   // show what is actually used
        set(v);
        if (id === "capacity" && v > 0) save(LS.roomOk, false);
        save(key, id === "capacity" ? state.capacity : state.jacobusBought);
        renderSoon();
      });
    }
    $("search").addEventListener("input", () => { state.search = $("search").value; renderSoon(); });
    const bagSoon = debounce(renderBag, 120);
    $("bagSearch").addEventListener("input", () => { state.bagSearch = $("bagSearch").value; bagSoon(); });
    $("bagClear").addEventListener("click", () => {
      state.owned = {};
      state.bagOrder = [];
      save(LS.owned, state.owned);
      render();
    });
    $("liveBtn").addEventListener("click", refreshLive);
    $("loadBtn").addEventListener("click", loadProfile);
    $("username").addEventListener("keydown", (e) => { if (e.key === "Enter") loadProfile(); });
    /** Toggles a disclosure panel and keeps its button's announced state honest. */
    const disclose = (btnId, boxId, otherBtnId, otherBoxId, focusId, onOpen) => {
      const box = $(boxId), other = $(otherBoxId);
      const open = box.hidden;
      box.hidden = !open;
      $(btnId).setAttribute("aria-expanded", String(open));
      if (open) {
        other.hidden = true;
        $(otherBtnId).setAttribute("aria-expanded", "false");
        if (onOpen) onOpen();
        $(focusId).focus();
      }
    };

    // Escape closes whichever panel is open, and hands focus back to its button.
    for (const [btnId, boxId] of [["progBtn", "progbox"], ["keyBtn", "keybox"]]) {
      $(boxId).addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        $(boxId).hidden = true;
        $(btnId).setAttribute("aria-expanded", "false");
        $(btnId).focus();
      });
    }

    $("keyBtn").addEventListener("click", () =>
      disclose("keyBtn", "keybox", "progBtn", "progbox", "apikey", () => { $("apikey").value = load(LS.key, ""); }));

    // ---- what the player has unlocked ----
    const progInputs = [
      ...SLAYERS.map((k) => [$("sl-" + k), () => state.progress.slayer[k], (v) => { state.progress.slayer[k] = v; }, "num"]),
      [$("hotm"), () => state.progress.hotm, (v) => { state.progress.hotm = v; }, "num"],
      ...TROPHIES.map((t) => [$("tr-" + t), () => state.progress.trophy[t], (v) => { state.progress.trophy[t] = v; }, "sel"]),
    ];

    // Reflect what was saved, then keep state and storage in step.
    for (const [input, get, set, kind] of progInputs) {
      if (!input) continue;
      const saved = get();
      if (kind === "num") input.value = String(saved || 0);
      else input.value = saved || "NONE";
      input.addEventListener("input", () => {
        const cap = Number(input.max) || Infinity;
        set(kind === "num" ? Math.min(cap, Math.max(0, Number(input.value) || 0)) : input.value);
        save(LS.progress, state.progress);
        renderSoon();
      });
    }

    $("progBtn").addEventListener("click", () =>
      disclose("progBtn", "progbox", "keyBtn", "keybox", "sl-zombie"));

    $("hideLocked").checked = state.hideLocked;
    $("hideLocked").addEventListener("change", () => {
      state.hideLocked = $("hideLocked").checked;
      save(LS.hideLocked, state.hideLocked);
      render();
    });
    $("saveKey").addEventListener("click", () => {
      const v = $("apikey").value.trim();
      save(LS.key, v);
      $("keybox").hidden = true;
      note(v ? "API key saved in this browser." : "API key cleared.", "good");
      if (v && $("username").value.trim()) loadProfile();
    });
    $("clearKey").addEventListener("click", () => {
      save(LS.key, "");
      $("apikey").value = "";
      note("API key cleared.", "good");
    });
    $("startBtn").addEventListener("click", () => { selectTab("bag"); $("bagSearch").focus(); });
    $("skipBtn").addEventListener("click", () => { save(LS.seen, true); $("onboard").hidden = true; });

    selectTab("value");
  }

  boot();
})();
