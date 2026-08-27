/**
 * Accessory Power (formerly "Magical Power") engine.
 *
 * Rules implemented, all verified against hypixelskyblock.minecraft.wiki:
 *   - Power per rarity: Common 3, Uncommon 5, Rare 8, Epic 12, Legendary 16, Mythic 22,
 *     Divine 28, Special 3, Very Special 5, Ultimate 1.
 *   - Only the highest-power accessory in an upgrade family counts; duplicates never stack.
 *   - Hegemony Artifact grants double power.
 *   - Rift Prism grants 11 once imbued at Erihann (not its Rare 8).
 *   - Abicase grants its rarity power PLUS 1 per 2 Abiphone contacts.
 *   - Celestial Starstone (CRUX_TALISMAN_7) grants NO power, despite topping the Crux family.
 *   - Recombobulator 3000 raises rarity by one step, capped at Mythic.
 *   - Stat multiplier = 29.97 * (ln(0.0019 * AP + 1)) ^ 1.2
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MP = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

  /** Power a single accessory contributes, given whether it's recombobulated. */
  function powerOf(cat, acc, recombobulated, contacts) {
    let rarity = acc.rarity;
    if (recombobulated && acc.recombable) {
      const i = cat.rules.ladder.indexOf(rarity);
      if (i >= 0 && i < cat.rules.ladder.length - 1) rarity = cat.rules.ladder[i + 1];
    }
    let mp = acc.id in cat.rules.overrides ? cat.rules.overrides[acc.id] : (cat.rules.mpByRarity[rarity] ?? 0);
    if (acc.dynamic === "double") mp *= 2;
    if (acc.dynamic === "abiphone") mp += Math.floor((contacts || 0) / 2);
    return mp;
  }

  /** The rarity an accessory ends up at once recombobulated. */
  function recombRarity(cat, acc) {
    const i = cat.rules.ladder.indexOf(acc.rarity);
    return acc.recombable && i >= 0 && i < cat.rules.ladder.length - 1 ? cat.rules.ladder[i + 1] : null;
  }

  function multiplier(ap) {
    if (ap <= 0) return 0;
    return 29.97 * Math.pow(Math.log(0.0019 * ap + 1), 1.2);
  }

  /**
   * What the player has right now.
   * owned: { [id]: { recomb: boolean } }
   */
  function evaluate(cat, owned, opts) {
    const contacts = opts?.contacts || 0;
    const byId = cat.byId;
    const families = [];
    let total = 0;

    for (const [key, fam] of Object.entries(cat.families)) {
      let best = null;
      for (const id of fam.members) {
        const has = owned[id];
        if (!has) continue;
        const mp = powerOf(cat, byId[id], !!has.recomb, contacts);
        if (!best || mp > best.mp) best = { id, mp, recomb: !!has.recomb };
      }
      // Everything you own in this family beyond `best` is dead weight.
      const ownedIds = fam.members.filter((id) => owned[id]);
      if (best) {
        total += best.mp;
        families.push({ key, name: fam.name, best, ownedIds, wasted: ownedIds.filter((id) => id !== best.id) });
      }
    }

    return { total, multiplier: multiplier(total), families, contacts };
  }

  /**
   * Every way to raise accessory power, priced.
   *
   * prices: { lowestBin: { "ID|RARITY|RECOMB": {price,count} }, recombobulator: {buy} }
   * Returns one entry per (family, achievable target), each with the cheapest route.
   */
  function offers(cat, owned, prices, opts) {
    const contacts = opts?.contacts || 0;
    const includeRecomb = opts?.includeRecomb !== false;
    const byId = cat.byId;
    const low = prices?.lowestBin || {};
    const recombCost = prices?.recombobulator?.buy ?? null;
    const out = [];

    for (const [key, fam] of Object.entries(cat.families)) {
      // Current power from this family.
      let current = 0, currentId = null;
      for (const id of fam.members) {
        if (!owned[id]) continue;
        const mp = powerOf(cat, byId[id], !!owned[id].recomb, contacts);
        if (mp > current) { current = mp; currentId = id; }
      }

      const candidates = [];
      for (const id of fam.members) {
        const acc = byId[id];
        const has = owned[id];

        // Route A — plain copy at base rarity.
        const plain = low[`${id}|${acc.rarity}|0`];
        if (!has && plain) {
          candidates.push({ id, rarity: acc.rarity, recomb: false, cost: plain.price, listings: plain.count, route: "buy" });
        }

        if (!includeRecomb || !acc.recombable) continue;
        const up = recombRarity(cat, acc);
        if (!up) continue;

        // Route B — buy one already recombobulated.
        const pre = low[`${id}|${up}|1`];
        if (!has && pre) {
          candidates.push({ id, rarity: up, recomb: true, cost: pre.price, listings: pre.count, route: "buy-recombobulated" });
        }

        // Route C — buy plain, apply your own Recombobulator 3000.
        if (!has && plain && recombCost) {
          candidates.push({ id, rarity: up, recomb: true, cost: plain.price + recombCost, listings: plain.count, route: "buy+recombobulate" });
        }

        // Route D — you already own it un-recombobulated; just recombobulate it.
        if (has && !has.recomb && recombCost) {
          candidates.push({ id, rarity: up, recomb: true, cost: recombCost, listings: null, route: "recombobulate-owned" });
        }
      }

      // Collapse to the cheapest route per resulting power level.
      const bestByMp = new Map();
      for (const c of candidates) {
        const mp = powerOf(cat, byId[c.id], c.recomb, contacts);
        if (mp <= current) continue; // no gain
        const prev = bestByMp.get(mp);
        if (!prev || c.cost < prev.cost) bestByMp.set(mp, { ...c, mp });
      }

      for (const c of bestByMp.values()) {
        out.push({
          family: key,
          familyName: fam.name,
          id: c.id,
          name: byId[c.id].name,
          rarity: c.rarity,
          recomb: c.recomb,
          route: c.route,
          listings: c.listings,
          cost: c.cost,
          fromMp: current,
          fromId: currentId,
          toMp: c.mp,
          gain: c.mp - current,
          coinsPerMp: c.cost / (c.mp - current),
        });
      }
    }

    out.sort((a, b) => a.coinsPerMp - b.coinsPerMp);
    return out;
  }

  /** Only the highest-power offer for each family (the "get me to max tier" list). */
  function maxTierOffers(all) {
    const best = new Map();
    for (const o of all) {
      const prev = best.get(o.family);
      if (!prev || o.toMp > prev.toMp || (o.toMp === prev.toMp && o.cost < prev.cost)) best.set(o.family, o);
    }
    return [...best.values()].sort((a, b) => a.coinsPerMp - b.coinsPerMp);
  }

  /**
   * Greedy budget solver. Each family can be bought at most once, so we repeatedly
   * take the best coins-per-power offer that still fits, then drop that family.
   * Greedy is an approximation, not a proven optimum — the UI says so.
   */
  function solveBudget(all, budget) {
    const pool = [...all].sort((a, b) => a.coinsPerMp - b.coinsPerMp);
    const used = new Set();
    const picks = [];
    let spend = 0, gain = 0;

    for (const o of pool) {
      if (used.has(o.family)) continue;
      if (spend + o.cost > budget) continue;
      used.add(o.family);
      picks.push(o);
      spend += o.cost;
      gain += o.gain;
    }
    return { picks, spend, gain };
  }

  /** Accessories you can't buy — they have to be earned. Sorted by power on offer. */
  function earnable(cat, owned, prices, opts) {
    const contacts = opts?.contacts || 0;
    const low = prices?.lowestBin || {};
    const byId = cat.byId;
    const out = [];

    for (const [key, fam] of Object.entries(cat.families)) {
      let current = 0;
      for (const id of fam.members) {
        if (!owned[id]) continue;
        current = Math.max(current, powerOf(cat, byId[id], !!owned[id].recomb, contacts));
      }
      let best = null;
      for (const id of fam.members) {
        const acc = byId[id];
        if (owned[id]) continue;
        const purchasable = Object.keys(low).some((k) => k.startsWith(id + "|"));
        if (purchasable) continue;
        const mp = powerOf(cat, acc, false, contacts);
        if (mp > current && (!best || mp > best.mp)) best = { id, mp, acc };
      }
      if (best) {
        out.push({
          family: key, familyName: fam.name, id: best.id, name: best.acc.name,
          rarity: best.acc.rarity, gain: best.mp - current, toMp: best.mp,
          rift: best.acc.rift, soulbound: best.acc.soulbound, dungeon: best.acc.dungeon,
        });
      }
    }
    out.sort((a, b) => b.gain - a.gain);
    return out;
  }

  /** Index a raw accessories.json for fast lookup. */
  function index(doc) {
    return { ...doc, byId: Object.fromEntries(doc.accessories.map((a) => [a.id, a])) };
  }

  return { index, powerOf, recombRarity, multiplier, evaluate, offers, maxTierOffers, solveBudget, earnable };
});
