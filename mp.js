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
    const progress = opts?.progress;
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
        const gate = requirementStatus(byId[c.id], progress);
        out.push({
          locked: !gate.met,
          needs: gate.needs,
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

  /**
   * One offer per family, the best value in it.
   *
   * offers() emits a row per reachable power level, so a family could suggest both the
   * Ring and the Artifact above it. As a shopping order that is actively misleading:
   * you would never buy both, and buying the Ring first is money thrown away if the
   * Artifact is where you land. Collapse to the best coins-per-power in each family and
   * flag that the family goes higher.
   */
  function bestPerFamily(all) {
    const best = new Map();
    const higher = new Map();
    for (const o of all) {
      const cur = best.get(o.family);
      if (!cur || o.coinsPerMp < cur.coinsPerMp) best.set(o.family, o);
      const top = higher.get(o.family);
      if (!top || o.toMp > top) higher.set(o.family, o.toMp);
    }
    return [...best.values()]
      .map((o) => ({ ...o, familyTopMp: higher.get(o.family) }))
      .sort((a, b) => a.coinsPerMp - b.coinsPerMp);
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

    // Keys look like "ID|RARITY|RECOMB"; collect the ids once instead of re-scanning
    // every key for each of the 423 accessories.
    const listed = new Set();
    for (const k of Object.keys(low)) listed.add(k.slice(0, k.indexOf("|")));

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
        if (listed.has(id)) continue;
        const mp = powerOf(cat, acc, false, contacts);
        if (mp > current && (!best || mp > best.mp)) best = { id, mp, acc };
      }
      if (best) {
        const gate = requirementStatus(best.acc, opts?.progress);
        out.push({
          locked: !gate.met, needs: gate.needs,
          family: key, familyName: fam.name, id: best.id, name: best.acc.name,
          rarity: best.acc.rarity, gain: best.mp - current, toMp: best.mp,
          rift: best.acc.rift, soulbound: best.acc.soulbound, dungeon: best.acc.dungeon,
        });
      }
    }
    out.sort((a, b) => b.gain - a.gain);
    return out;
  }


  /* ---------------- requirements ---------------- */

  const TROPHY_RANK = { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3, DIAMOND: 4 };
  const SLAYER_NAME = {
    zombie: "Revenant", spider: "Tarantula", wolf: "Sven",
    enderman: "Voidgloom", blaze: "Inferno", vampire: "Riftstalker",
  };

  /**
   * Can this player actually obtain the accessory?
   *
   * 39 accessories sit behind slayer levels, Heart of the Mountain tiers or
   * trophy-fishing rewards. `progress` is what the player says they have; anything it
   * does not mention is treated as not met, so the honest default is that a gated item
   * is locked until you say otherwise.
   *
   * Returns { met, needs: [human-readable strings] }.
   */
  function requirementStatus(acc, progress) {
    if (!acc.req || !acc.req.length) return { met: true, needs: [] };
    const p = progress || {};
    const needs = [];

    for (const r of acc.req) {
      if (r.type === "SLAYER") {
        const have = (p.slayer && p.slayer[r.slayer_boss_type]) || 0;
        if (have < r.level) needs.push(`${SLAYER_NAME[r.slayer_boss_type] || r.slayer_boss_type} slayer ${r.level}`);
      } else if (r.type === "HEART_OF_THE_MOUNTAIN") {
        if (((p.hotm) || 0) < r.tier) needs.push(`Heart of the Mountain ${r.tier}`);
      } else if (r.type === "TROPHY_FISHING") {
        const have = TROPHY_RANK[(p.trophy && p.trophy[r.trophy_type]) || "NONE"] || 0;
        if (have < (TROPHY_RANK[r.reward] || 0)) {
          needs.push(`${r.reward.toLowerCase()} ${r.trophy_type.toLowerCase()} trophy fishing`);
        }
      } else {
        // An unknown gate is still a gate — name it rather than quietly allowing it.
        needs.push(String(r.type).replace(/_/g, " ").toLowerCase());
      }
    }
    return { met: needs.length === 0, needs };
  }

  /**
   * What in the bag is doing nothing, and what to put there instead.
   *
   * The accessory bag has a finite number of slots, and an accessory that loses to a
   * higher tier in its own family still occupies one. This finds that dead weight,
   * then spends the freed slots on the best power available to this player.
   */
  function slotPlan(cat, owned, prices, opts) {
    const contacts = opts?.contacts || 0;
    const progress = opts?.progress;
    const byId = cat.byId;

    const dead = [];
    for (const [key, fam] of Object.entries(cat.families)) {
      const held = fam.members.filter((id) => owned[id]);
      if (!held.length) continue;

      let best = null;
      for (const id of held) {
        const mp = powerOf(cat, byId[id], !!owned[id].recomb, contacts);
        if (!best || mp > best.mp) best = { id, mp };
      }
      for (const id of held) {
        if (id === best.id) continue;
        const mp = powerOf(cat, byId[id], !!owned[id].recomb, contacts);
        dead.push({
          id,
          name: byId[id].name,
          rarity: byId[id].rarity,
          mp,
          familyName: fam.name,
          reason: "outranked",
          beatenBy: byId[best.id].name,
          beatenByMp: best.mp,
        });
      }
      // The Celestial Starstone tops the Crux tree and grants nothing at all, so it can
      // be the family's only held member and still be pure dead weight.
      if (best.mp === 0) {
        dead.push({
          id: best.id,
          name: byId[best.id].name,
          rarity: byId[best.id].rarity,
          mp: 0,
          familyName: fam.name,
          reason: "grants no power",
          beatenBy: null,
        });
      }
    }
    dead.sort((a, b) => a.mp - b.mp || a.name.localeCompare(b.name));

    // Fill the freed slots with the best power this player can actually reach.
    const candidates = offers(cat, owned, prices, opts)
      .filter((o) => !o.locked)
      .sort((a, b) => b.gain - a.gain || a.cost - b.cost);

    const takenFamily = new Set();
    const fills = [];
    for (const o of candidates) {
      if (fills.length >= dead.length) break;
      if (takenFamily.has(o.family)) continue;
      takenFamily.add(o.family);
      fills.push(o);
    }

    return {
      held: Object.keys(owned).length,
      dead,
      freed: dead.length,
      deadPower: dead.reduce((n, d) => n + d.mp, 0),
      fills,
      gain: fills.reduce((n, o) => n + o.gain, 0),
      spend: fills.reduce((n, o) => n + o.cost, 0),
    };
  }



  /**
   * Jacobus sells accessory bag slots two at a time, at a price that steps up as you buy
   * more. Tiers below are from the wiki; the cumulative total they produce
   * (1.5M + 4x5M + 5x8M + 10x12M + 79x20M) is exactly 1,761,500,000, which is the figure
   * the wiki states independently for maxing him out — so the tiers reconcile.
   *
   * `bought` is how many upgrades the player has already purchased (0 = none yet).
   */
  const JACOBUS_TIERS = [
    { upTo: 1, cost: 1_500_000 },
    { upTo: 5, cost: 5_000_000 },
    { upTo: 10, cost: 8_000_000 },
    { upTo: 20, cost: 12_000_000 },
    { upTo: 99, cost: 20_000_000 },
  ];
  const JACOBUS_SLOTS_PER_UPGRADE = 2;
  const JACOBUS_MAX_UPGRADES = 99;

  function jacobusNext(bought) {
    const n = Math.max(0, Math.floor(Number(bought) || 0)) + 1;
    if (n > JACOBUS_MAX_UPGRADES) return null;          // already maxed
    const tier = JACOBUS_TIERS.find((t) => n <= t.upTo);
    return { upgrade: n, slots: JACOBUS_SLOTS_PER_UPGRADE, cost: tier.cost };
  }

  /**
   * What to do when the bag is full.
   *
   * Every other view assumes an empty slot is waiting, which is useless advice once the
   * bag is packed: adding anything means taking something out. Three kinds of move, and
   * they are genuinely different:
   *
   *   - dead weight    an accessory outranked inside its own family. Removing it costs
   *                    nothing at all, so it is always the first slot to reclaim.
   *   - upgrade        a higher tier of a family you already hold. Slot-neutral — the old
   *                    one comes out as the new one goes in — so it works even at 0 free.
   *   - swap           a brand-new family. Needs a slot, so it displaces your weakest
   *                    contributor, and only counts if it beats what it pushes out.
   *
   * `capacity` of 0 means the player has not said, and everything is treated as a plain
   * addition, which is what the rest of the app already assumes.
   */
  function capacityPlan(cat, owned, prices, opts) {
    const contacts = opts?.contacts || 0;
    const byId = cat.byId;

    const held = Object.keys(owned).length;
    // An unset slot count is assumed to equal what is held, rather than treated as
    // unlimited: a bag you have not measured is far more often full than infinite, and
    // assuming infinite is the assumption that produces advice which cannot be followed.
    // `assumeFull` is false once the player says they have room.
    const stated = Number(opts?.capacity) || 0;
    const assumed = !stated && held >= 5 && opts?.assumeFull !== false;
    const capacity = stated || (assumed ? held : 0);
    const dead = slotPlan(cat, owned, prices, opts).dead;
    const deadIds = new Set(dead.map((d) => d.id));

    // Reclaiming dead weight is free, so it counts toward the space available.
    const free = capacity ? Math.max(0, capacity - held) + dead.length : Infinity;
    const full = capacity > 0 && free <= 0;

    // The rest of the app hides what the player cannot obtain unless they ask to see it;
    // this view was filtering unconditionally, so the toggle did nothing on a full bag.
    const hideLocked = opts?.hideLocked !== false;
    const reachable = offers(cat, owned, prices, opts).filter((o) => !hideLocked || !o.locked);
    // fromMp > 0 means this family already contributes, so the purchase replaces a member
    // rather than claiming a new slot.
    const upgrades = reachable.filter((o) => o.fromMp > 0);
    const additions = reachable.filter((o) => o.fromMp === 0);


    // The weakest things in the bag are what a brand-new accessory would displace.
    //
    // A family listed under `upgrades` must not also sit on the bench: the two tables would
    // then double-book it, and following the upgrades first — which is what the page tells
    // you to do — leaves the swap displacing something that no longer exists, making its
    // net gain fiction. Such a family is instead benched at the power it will have AFTER
    // the upgrade, since that is what a swap would really be giving up.
    const evalNow = evaluate(cat, owned, opts);
    const upgradeTo = new Map();
    for (const u of upgrades) {
      const cur = upgradeTo.get(u.family);
      if (cur == null || u.toMp > cur) upgradeTo.set(u.family, u.toMp);
    }
    const bench = evalNow.families
      .map((f) => ({
        id: f.best.id,
        name: byId[f.best.id].name,
        rarity: byId[f.best.id].rarity,
        mp: upgradeTo.has(f.key) ? upgradeTo.get(f.key) : f.best.mp,
        upgraded: upgradeTo.has(f.key),
        family: f.key,
      }))
      .filter((c) => !deadIds.has(c.id))
      .sort((a, b) => a.mp - b.mp);

    // Pair the biggest additions against the weakest holdings, each used once.
    const bestAdditions = [...additions].sort((a, b) => b.toMp - a.toMp || a.cost - b.cost);
    const swaps = [];
    const usedFamily = new Set();
    let benchIdx = 0;

    for (const o of bestAdditions) {
      if (benchIdx >= bench.length) break;
      if (usedFamily.has(o.family)) continue;
      const out = bench[benchIdx];
      const net = o.toMp - out.mp;
      if (net <= 0) break;                 // sorted descending: nothing after this wins either
      usedFamily.add(o.family);
      benchIdx++;
      swaps.push({
        ...o,
        replaces: out,
        netGain: net,
        coinsPerNet: o.cost / net,
      });
    }
    swaps.sort((a, b) => a.coinsPerNet - b.coinsPerNet);

    // Buying slots is itself a purchase that competes on coins per power. Swapping keeps
    // only the difference between the new accessory and the one it pushes out; paying
    // Jacobus keeps the whole thing. Whether that is worth it depends entirely on how
    // strong the accessory you would have displaced was.
    // Only when the player actually stated their slot count. Recommending a real coin
    // purchase off an inferred capacity — and an unstated jacobusBought that defaults to
    // 0, so a maxed player would be quoted 1.5M for slots costing 20M — is guessing with
    // someone else's money.
    let slotBuy = null;
    if (full && !assumed) {
      const next = jacobusNext(opts?.jacobusBought);
      if (next) {
        const take = bestAdditions.filter((o, i, arr) =>
          arr.findIndex((x) => x.family === o.family) === i).slice(0, next.slots);
        const gain = take.reduce((n, o) => n + o.toMp, 0);
        const spendOnItems = take.reduce((n, o) => n + o.cost, 0);
        if (gain > 0) {
          slotBuy = {
            ...next,
            fills: take,
            gain,
            spendOnItems,
            totalCost: next.cost + spendOnItems,
            coinsPerMp: (next.cost + spendOnItems) / gain,
          };
          // Like-for-like: the SAME accessories, acquired by swapping instead of by buying
          // slots. Comparing against the top of the swap list would be comparing different
          // items and the stated saving would not be the one the reader is being shown.
          let rivalGain = 0, displaced = 0, benchAt = 0;
          for (const o of take) {
            if (benchAt >= bench.length) break;
            const out = bench[benchAt++];
            rivalGain += Math.max(0, o.toMp - out.mp);
            displaced += out.mp;
          }
          slotBuy.swapGain = rivalGain;
          slotBuy.swapCoinsPerMp = rivalGain > 0 ? spendOnItems / rivalGain : Infinity;
          slotBuy.worthIt = slotBuy.coinsPerMp < slotBuy.swapCoinsPerMp;
          slotBuy.keptAP = displaced;   // power you would have thrown away by swapping
        }
      }
    }

    return {
      capacity, held, free: capacity ? free : null, full, assumed,
      hiddenLocked: hideLocked
        ? bestPerFamily(offers(cat, owned, prices, opts).filter((o) => o.locked)).length : 0,
      dead,
      upgrades: upgrades.sort((a, b) => a.coinsPerMp - b.coinsPerMp),
      swaps,
      slotBuy,
      netGain: swaps.reduce((n, x) => n + x.netGain, 0),
      spend: swaps.reduce((n, x) => n + x.cost, 0),
    };
  }

  /** Index a raw accessories.json for fast lookup. */
  function index(doc) {
    return { ...doc, byId: Object.fromEntries(doc.accessories.map((a) => [a.id, a])) };
  }

  return {
    index, powerOf, recombRarity, multiplier, evaluate, offers, maxTierOffers,
    solveBudget, earnable, requirementStatus, slotPlan, capacityPlan, jacobusNext, bestPerFamily, SLAYER_NAME, TROPHY_RANK,
  };
});
