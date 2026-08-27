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
  const LS = { owned: "apl:owned", contacts: "apl:contacts", budget: "apl:budget", prices: "apl:prices", seen: "apl:seen" };
  const COFL = "https://sky.coflnet.com/api";
  const PRICE_TTL = 30 * 60 * 1000;

  let cat = null;
  let prices = null;

  const state = {
    owned: load(LS.owned, {}),
    contacts: Number(load(LS.contacts, 0)) || 0,
    tab: "value",
    search: "",
    bagSearch: "",
    sort: "rate",
    sortDir: 1,
    bagOrder: [],       // frozen while the bag tab is open, so ticking never reorders under the cursor
    liveState: "idle",
  };

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
  async function firstOf(urls) {
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.lowestBin && Object.keys(j.lowestBin).length) return j;
      } catch { /* try the next one */ }
    }
    return { generated: 0, lowestBin: {} };
  }

  async function boot() {
    cat = MP.index(window.__CATALOGUE__ || await (await fetch("data/accessories.json")).json());

    const cached = load(LS.prices, null);
    if (cached && cached.lowestBin && Date.now() - cached.generated < PRICE_TTL) prices = cached;
    else prices = window.__PRICES__ || null;

    // Local server sweeps the whole Auction House itself; a static host has neither,
    // so fall through to the committed snapshot before giving up.
    if (!prices) prices = await firstOf(["api/prices", "data/prices-snapshot.json"]);

    $("contacts").value = state.contacts;
    $("budget").value = load(LS.budget, "100m");
    wire();
    stamp();
    render();

    // Local server already has a full live sweep; only the hosted build needs to reach out.
    if (!window.__PRICES__ && prices.lowestBin && Object.keys(prices.lowestBin).length) return;
  }

  function stamp() {
    const n = Object.keys(prices.lowestBin || {}).length;
    const age = prices.generated ? Date.now() - prices.generated : Infinity;
    const led = $("led");
    led.className = "led" + (state.liveState === "busy" ? " busy" : age > 6 * 3600e3 ? " stale" : "");
    $("stampText").textContent = state.liveState === "busy"
      ? "fetching live prices…"
      : `${n} listings · ${prices.generated ? ago(prices.generated) : "snapshot"}`;
    $("footFresh").textContent = prices.source === "live"
      ? `Prices fetched live from current Auction House BIN listings, ${ago(prices.generated)}.`
      : `Prices are a baked snapshot. Hit “Live prices” for current Auction House listings — where the host allows it.`;
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

        for (let attempt = 0; attempt <= RETRIES && !list; attempt++) {
          if (attempt) await sleep(300 * attempt * attempt);
          try {
            const r = await fetch(`${COFL}/auctions/tag/${id}/active/bin`);
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
        $("progressFill").style.width = ((done / ids.length) * 100).toFixed(1) + "%";
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

    if (blocked || ok === 0) {
      note("Live prices are blocked on this page — the published Artifact runs under a policy that forbids "
        + "calls to other sites. The snapshot below still works. Run the local copy for live Auction House data.", "warn");
      stamp();
      return;
    }

    prices = { generated: Date.now(), source: "live", recombobulator, lowestBin };
    save(LS.prices, prices);
    note(`Live prices in: ${Object.keys(lowestBin).length} listings across ${ok} accessories.`
      + (failed ? ` ${failed} could not be reached.` : ""), "good");
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

  /* ---------------- derive ---------------- */

  function derive() {
    const opts = { contacts: state.contacts, includeRecomb: $("useRecomb").checked };
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
    let out = q ? list.filter((o) => o.name.toLowerCase().includes(q) || o.familyName.toLowerCase().includes(q)) : list.slice();
    out.sort(SORTS[state.sort] || SORTS.rate);
    if (state.sortDir < 0) out.reverse();
    return out;
  }

  /* ---------------- rows ---------------- */

  function header(target) {
    const h = el("div", "lhead");
    h.append(el("span", "h-edge"));
    h.append(el("span", "h-idx"));
    const cols = [["name", "Accessory", "h-name"], ["gain", "Power", ""], ["cost", "Price", ""], ["rate", "Per AP", "h-rate"]];
    for (const [key, label, cls] of cols) {
      const b = el("button", cls);
      b.type = "button";
      b.append(document.createTextNode(label));
      const active = state.sort === key;
      b.setAttribute("aria-sort", active ? (state.sortDir > 0 ? "ascending" : "descending") : "none");
      if (active) b.append(el("span", "arrow", state.sortDir > 0 ? "▲" : "▼"));
      b.addEventListener("click", () => {
        if (state.sort === key) state.sortDir *= -1;
        else { state.sort = key; state.sortDir = 1; }
        render();
      });
      h.append(b);
    }
    target.append(h);
  }

  function entry(o, i) {
    const row = el("div", "entry");
    const edge = el("div", "edge");
    edge.style.background = rarityVar(o.rarity);
    row.append(edge, el("div", "idx", i == null ? "" : String(i + 1)));

    const body = el("div", "body");
    const l1 = el("div", "line1");
    l1.append(el("span", "iname", o.name));
    const rar = el("span", "rarity", String(o.rarity).replace("_", " "));
    rar.style.color = rarityVar(o.rarity);
    l1.append(rar);
    if (o.recomb) l1.append(el("span", "chip recomb", "recombobulated"));
    if (o.familyName && o.familyName !== o.name) l1.append(el("span", "line-of", o.familyName + " line"));
    body.append(l1);

    const l2 = el("div", "line2");
    l2.append(el("span", null, ROUTE[o.route] || o.route));
    if (o.fromMp > 0) { l2.append(el("span", "sep", "·")); l2.append(el("span", null, `${o.fromMp} → ${o.toMp} in this line`)); }
    if (o.listings) { l2.append(el("span", "sep", "·")); l2.append(el("span", null, `${o.listings} listed`)); }
    body.append(l2);
    row.append(body);

    row.append(el("div", "num c-power", "+" + o.gain));
    row.append(el("div", "num c-price", coins(o.cost)));
    row.append(el("div", "num c-rate", coins(o.coinsPerMp)));
    return row;
  }

  function fill(node, list, make, emptyText) {
    node.textContent = "";
    if (!list.length) { node.append(el("div", "empty", emptyText)); return; }
    list.forEach((x, i) => node.append(make(x, i)));
  }

  /* ---------------- render ---------------- */

  const CAP = 150;

  function render() {
    // Full re-render nukes focus; put it back where the keyboard user left it.
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.focusKey : null;

    const d = derive();
    renderStrip(d);
    renderCounts(d);
    renderValue(d);
    renderMax(d);
    renderPlan(d);
    renderEarn(d);
    renderFree(d);
    renderBag();
    renderOnboard(d);

    if (focusKey) {
      const back = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (back) back.focus({ preventScroll: true });
    }
  }

  function renderCounts(d) {
    const set = (tab, n) => { const e = document.querySelector(`.tab[data-tab="${tab}"] .count`); if (e) e.textContent = n; };
    set("value", d.all.length);
    set("max", d.maxTier.length);
    set("earn", d.earn.length);
    set("bag", Object.keys(state.owned).length);
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

  function renderValue({ all }) {
    const node = $("valueList");
    node.textContent = "";
    header(node);
    const view = applyView(all);
    const body = el("div", "ledger");
    fill(body, view.slice(0, CAP), entry,
      state.search ? "No upgrade matches that search." : "Nothing left to buy — every purchasable family is at its best tier.");
    node.append(body);
    if (view.length > CAP) node.append(el("div", "empty", `Showing ${CAP} of ${view.length}. Narrow it with the search box.`));
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
    header(node);
    const body = el("div", "ledger");
    fill(body, view, entry, "Every purchasable family is already maxed.");
    node.append(body);
  }

  function renderPlan({ all, evalNow }) {
    const budget = parseCoins($("budget").value);
    const sum = $("planSummary");
    sum.textContent = "";
    if (!isFinite(budget)) {
      sum.append(el("div", "empty", "Enter a budget like 250m or 1.5b."));
      $("planList").textContent = "";
      return;
    }
    const s = MP.solveBudget(all, budget);
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
    header(node);
    const body = el("div", "ledger");
    fill(body, s.picks, entry, "Nothing fits that budget — the cheapest upgrade costs more.");
    node.append(body);
  }

  function renderEarn({ earn }) {
    fill($("earnList"), earn, (e, i) => {
      const row = el("div", "entry");
      const edge = el("div", "edge");
      edge.style.background = rarityVar(e.rarity);
      row.append(edge, el("div", "idx", String(i + 1)));
      const body = el("div", "body");
      const l1 = el("div", "line1");
      l1.append(el("span", "iname", e.name));
      const rar = el("span", "rarity", String(e.rarity).replace("_", " "));
      rar.style.color = rarityVar(e.rarity);
      l1.append(rar);
      if (e.rift) l1.append(el("span", "chip rift", "rift"));
      if (e.soulbound) l1.append(el("span", "chip soul", "soulbound " + String(e.soulbound).toLowerCase()));
      if (e.dungeon) l1.append(el("span", "chip dungeon", "dungeon"));
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

  function renderBag() {
    const list = bagList();
    $("bagCount").textContent = `${Object.keys(state.owned).length} owned · ${list.length} shown`;

    fill($("bagList"), list.slice(0, 300), (a) => {
      const has = state.owned[a.id];
      const row = el("div", "entry pick" + (has ? " own" : ""));
      const edge = el("div", "edge");
      edge.style.background = rarityVar(a.rarity);
      row.append(edge);

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
      row.append(box);

      const body = el("div", "body");
      const l1 = el("div", "line1");
      l1.append(el("span", "iname", a.name));
      const rar = el("span", "rarity", String(a.rarity).replace("_", " "));
      rar.style.color = rarityVar(a.rarity);
      l1.append(rar);
      if (a.rift) l1.append(el("span", "chip rift", "rift"));
      if (a.soulbound) l1.append(el("span", "chip soul", "soulbound"));
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
  }

  /* ---------------- tabs ---------------- */

  const TABS = ["value", "max", "plan", "earn", "free", "bag"];

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
    if (name === "bag") renderBag();
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

    $("budget").addEventListener("input", () => { save(LS.budget, $("budget").value); render(); });
    $("contacts").addEventListener("input", () => {
      const max = cat.rules.abiphoneContactsKnown;
      const raw = Number($("contacts").value) || 0;
      state.contacts = Math.min(max, Math.max(0, raw));   // unclamped input would poison every ranking
      if (raw > max) $("contacts").value = state.contacts;
      save(LS.contacts, state.contacts);
      render();
    });
    $("useRecomb").addEventListener("change", render);
    $("search").addEventListener("input", () => { state.search = $("search").value; render(); });
    $("bagSearch").addEventListener("input", () => { state.bagSearch = $("bagSearch").value; renderBag(); });
    $("bagClear").addEventListener("click", () => {
      state.owned = {};
      state.bagOrder = [];
      save(LS.owned, state.owned);
      render();
    });
    $("liveBtn").addEventListener("click", refreshLive);
    $("startBtn").addEventListener("click", () => { selectTab("bag"); $("bagSearch").focus(); });
    $("skipBtn").addEventListener("click", () => { save(LS.seen, true); $("onboard").hidden = true; });

    selectTab("value");
  }

  boot();
})();
