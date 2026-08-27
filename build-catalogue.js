#!/usr/bin/env node
/**
 * Rebuilds data/accessories.json from live sources.
 *
 *   node build-catalogue.js
 *
 * Sources (both public, no API key):
 *   - https://api.hypixel.net/v2/resources/skyblock/items   (authoritative: every accessory + rarity)
 *   - NotEnoughUpdates-REPO constants/parents.json          (accessory upgrade families)
 *   - NotEnoughUpdates-REPO constants/abiphone.json         (Abiphone contact list, for Abicase power)
 *
 * Run this again whenever Hypixel adds accessories.
 */
const fs = require("fs");
const path = require("path");

const ITEMS_URL = "https://api.hypixel.net/v2/resources/skyblock/items";
const NEU = "https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/constants";

// Accessory Power per rarity. Source: hypixelskyblock.minecraft.wiki/w/Magical_Power
const MP_BY_RARITY = {
  COMMON: 3, UNCOMMON: 5, RARE: 8, EPIC: 12, LEGENDARY: 16,
  MYTHIC: 22, DIVINE: 28, SPECIAL: 3, VERY_SPECIAL: 5, ULTIMATE: 1, ADMIN: 22,
};

// Rarity ladder used by the Recombobulator 3000 (+1 step).
// Stops at Mythic on purpose: Divine is not obtainable by normal means, so nothing
// can be recombobulated into it.
const LADDER = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC"];

// Hand-verified exceptions to the rarity table.
const MP_OVERRIDE = {
  RIFT_PRISM: 11,        // grants 11 AP once imbued at Erihann, not its RARE 8
  CRUX_TALISMAN_7: 0,    // Celestial Starstone grants NO accessory power (wiki, explicit)
};

// Accessories whose power is computed, not fixed.
const DYNAMIC = {
  HEGEMONY_ARTIFACT: "double",  // grants double accessory power
  ABICASE: "abiphone",          // rarity power + 1 per 2 Abiphone contacts
};

// Families that don't follow the <BASE>_TALISMAN/_RING/_ARTIFACT/_RELIC naming and
// are missing from (or lag behind) NEU's parents.json.
const IRREGULAR = [
  [/^MASTER_SKULL_TIER_\d+$/, "MASTER_SKULL"],
  [/^BEASTMASTER_CREST_/, "BEASTMASTER_CREST"],
  [/SHARK_TOOTH_NECKLACE$/, "SHARK_TOOTH_NECKLACE"],
  [/^PERSONAL_COMPACTOR_/, "PERSONAL_COMPACTOR"],
  [/^PERSONAL_DELETOR_/, "PERSONAL_DELETOR"],
  [/^JERRY_TALISMAN_/, "JERRY_TALISMAN_COLOURS"],
  [/^ODGERS_(BRONZE|GOLD|DIAMOND)_TOOTH$/, "ODGERS_TOOTH"],
  [/^VOTER_BADGE/, "VOTER_BADGE"],
  [/^(NIBBLE_CHOCOLATE_STICK|SMOOTH_CHOCOLATE_BAR|RICH_CHOCOLATE_CHUNK|GANACHE_CHOCOLATE_SLAB|PRESTIGE_CHOCOLATE_REALM)$/, "CHOCOLATE"],
  [/^(FROZEN_CHICKEN|FRIED_FROZEN_CHICKEN)$/, "FROZEN_CHICKEN"],
  [/^(TALISMAN_OF_SPACE|RING_OF_SPACE|ARTIFACT_OF_SPACE)$/, "OF_SPACE"],
  [/^(TALISMAN_OF_COINS|RING_OF_COINS|ARTIFACT_OF_COINS|RELIC_OF_COINS)$/, "OF_COINS"],
  [/^(STUDENT_STUDIES|SCARF_STUDIES|MASTER_THESIS|SCARF_THESIS|PHD_GRIMOIRE|SCARF_GRIMOIRE|APPLICANT_STATEMENT)$/, "SCARF_STUDIES"],
];

const SUFFIXES = ["_TALISMAN", "_RING", "_ARTIFACT", "_RELIC", "_HEIRLOOM", "_CHRONOMICON"];

async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": "skyblock-mp/1.0 (personal tool)" } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

function rarityOf(item) {
  // Hypixel omits `tier` on plain Common items.
  return item.tier || "COMMON";
}

function basePower(id, rarity) {
  if (id in MP_OVERRIDE) return MP_OVERRIDE[id];
  return MP_BY_RARITY[rarity] ?? 0;
}

(async () => {
  console.log("fetching sources…");
  const [itemsRes, parents, abiphone] = await Promise.all([
    getJSON(ITEMS_URL),
    getJSON(`${NEU}/parents.json`),
    getJSON(`${NEU}/abiphone.json`),
  ]);

  const accessories = itemsRes.items.filter((i) => i.category === "ACCESSORY");
  const ids = new Set(accessories.map((a) => a.id));
  console.log(`  ${itemsRes.items.length} items -> ${accessories.length} accessories`);

  // ---- union-find over three family sources -------------------------------
  const parent = {};
  const find = (x) => { parent[x] = parent[x] ?? x; return parent[x] === x ? x : (parent[x] = find(parent[x])); };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  accessories.forEach((a) => (parent[a.id] = a.id));

  let fromParents = 0;
  for (const [top, kids] of Object.entries(parents)) {
    if (!ids.has(top)) continue;
    const own = kids.filter((k) => ids.has(k));
    if (own.length) fromParents++;
    own.forEach((k) => union(k, top));
  }

  const byBase = {};
  for (const a of accessories) {
    const suf = SUFFIXES.find((s) => a.id.endsWith(s));
    if (suf) (byBase[a.id.slice(0, -suf.length)] ??= []).push(a.id);
  }
  Object.values(byBase).forEach((g) => g.slice(1).forEach((x) => union(x, g[0])));

  const irregular = {};
  for (const a of accessories) {
    for (const [re, key] of IRREGULAR) if (re.test(a.id)) { (irregular[key] ??= []).push(a.id); break; }
  }
  Object.values(irregular).forEach((g) => g.slice(1).forEach((x) => union(x, g[0])));

  // ---- assemble -----------------------------------------------------------
  const contactsMax = Object.keys(abiphone).length;

  const out = accessories.map((a) => {
    const rarity = rarityOf(a);
    const rec = {
      id: a.id,
      name: a.name,
      rarity,
      mp: basePower(a.id, rarity),
      family: null,
      tradeable: a.can_trade !== false && a.can_auction !== false && !a.soulbound,
      soulbound: a.soulbound ?? null,
      rift: a.rift_transferrable === true || a.motes_sell_price !== undefined,
      dungeon: a.dungeon_item !== undefined,
      recombable: a.can_recombobulate !== false && LADDER.indexOf(rarity) >= 0 && LADDER.indexOf(rarity) < LADDER.length - 1,
    };
    // 39 accessories are gated behind slayer levels, Heart of the Mountain tiers or
    // trophy-fishing rewards. Recommending one to a player who cannot obtain it is
    // worse than not recommending it, so the gate travels with the item.
    if (a.requirements && a.requirements.length) rec.req = a.requirements;
    if (DYNAMIC[a.id]) rec.dynamic = DYNAMIC[a.id];
    return rec;
  });

  const byId = Object.fromEntries(out.map((a) => [a.id, a]));
  const groups = {};
  out.forEach((a) => (groups[find(a.id)] ??= []).push(a.id));

  const families = {};
  for (const members of Object.values(groups)) {
    // Order by accessory power, then by the canonical tier ladder as a tiebreak.
    const order = (id) => {
      const s = SUFFIXES.findIndex((x) => id.endsWith(x));
      return s < 0 ? 0 : s;
    };
    members.sort((x, y) => byId[y].mp - byId[x].mp || order(y) - order(x));
    const key = members[0];
    // Name the family after the shared words of its members.
    const famName = members.length === 1
      ? byId[key].name
      : sharedName(members.map((m) => byId[m].name)) || byId[key].name;
    families[key] = { name: famName, members };
    members.forEach((m) => (byId[m].family = key));
  }

  const doc = {
    generated: new Date().toISOString(),
    source: { items: ITEMS_URL, parents: `${NEU}/parents.json`, abiphone: `${NEU}/abiphone.json` },
    rules: {
      mpByRarity: MP_BY_RARITY,
      ladder: LADDER,
      overrides: MP_OVERRIDE,
      dynamic: DYNAMIC,
      abiphoneContactsKnown: contactsMax,
      statMultiplier: "29.97 * (ln(0.0019 * AP + 1)) ^ 1.2",
    },
    familiesFromParents: fromParents,
    accessories: out,
    families,
  };

  const dst = path.join(__dirname, "data", "accessories.json");
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, JSON.stringify(doc));

  const multi = Object.values(families).filter((f) => f.members.length > 1).length;
  const maxAP = theoreticalMax(out, families, byId, contactsMax);
  console.log(`  families: ${multi} multi-tier, ${Object.keys(families).length - multi} standalone`);
  console.log(`  theoretical max accessory power: ${maxAP}`);
  console.log(`wrote data/accessories.json (${(fs.statSync(dst).size / 1024).toFixed(1)} KB)`);
})().catch((e) => { console.error("build failed:", e.message); process.exit(1); });

// Longest common word-prefix of a family's display names ("Zombie Talisman", "Zombie Ring" -> "Zombie").
function sharedName(names) {
  const split = names.map((n) => n.split(" "));
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (split.every((s) => s[i] === w)) out.push(w); else break;
  }
  return out.join(" ").replace(/[,\-–]$/, "").trim();
}

function theoreticalMax(all, families, byId, contacts) {
  let total = 0;
  for (const f of Object.values(families)) {
    const best = Math.max(...f.members.map((m) => {
      const a = byId[m];
      let mp = a.mp;
      if (a.dynamic === "double") mp *= 2;
      if (a.dynamic === "abiphone") mp += Math.floor(contacts / 2);
      return mp;
    }));
    total += best;
  }
  return total;
}
