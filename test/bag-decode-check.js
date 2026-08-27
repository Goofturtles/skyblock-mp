/**
 * The one step that cannot be exercised without an approved Hypixel key: turning a
 * profile's talisman_bag blob into the accessory list the site consumes.
 *
 * Builds a gzipped NBT bag by hand — including a recombobulated copy, a duplicate,
 * and a non-accessory — and runs it through the proxy's own readNBT.
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// The proxy exports its parser, so this exercises the shipped code, not a copy.
const { readNBT } = require("../proxy/server.js");

/* ---- minimal NBT writer, only what a bag needs ---- */
function nbtStr(s) { const x = Buffer.from(s, "utf8"); return Buffer.concat([Buffer.from([x.length >> 8, x.length & 0xff]), x]); }
function named(tag, name, payload) { return Buffer.concat([Buffer.from([tag]), nbtStr(name), payload]); }
function compound(children) { return Buffer.concat([...children, Buffer.from([0])]); }
function intTag(v) { const x = Buffer.alloc(4); x.writeInt32BE(v); return x; }

function item(id, recomb) {
  const extra = compound([
    named(8, "id", nbtStr(id)),
    ...(recomb ? [named(3, "rarity_upgrades", intTag(1))] : []),
  ]);
  return compound([named(10, "ExtraAttributes", extra)]);
}
function emptySlot() { return compound([]); }

function bag(items) {
  const list = Buffer.concat([
    Buffer.from([10]),            // list of compounds
    intTag(items.length),
    ...items,
  ]);
  const root = compound([named(9, "i", list)]);
  return Buffer.concat([Buffer.from([10]), nbtStr(""), root]);
}

const blob = bag([
  item("ZOMBIE_TALISMAN", false),
  item("HEGEMONY_ARTIFACT", false),
  item("ZOMBIE_TALISMAN", true),     // duplicate, recombobulated — must win
  emptySlot(),                        // empty bag slot
  item("NOT_A_REAL_ACCESSORY", false),
  item("ABICASE", true),
]);

const gz = zlib.gzipSync(blob).toString("base64");
console.log(`built a synthetic bag: ${gz.length} base64 chars`);

/* ---- run it through the shipped parser + the proxy's dedup rule ---- */
const parsed = readNBT(zlib.gunzipSync(Buffer.from(gz, "base64")));
const items = parsed.i || [];
console.log(`decoded ${items.length} slots`);

const seen = new Map();
for (const it of items) {
  const extra = it && it.ExtraAttributes;
  if (!extra || !extra.id) continue;
  const recomb = !!extra.rarity_upgrades;
  if (!seen.has(extra.id) || (recomb && !seen.get(extra.id).recomb)) seen.set(extra.id, { id: extra.id, recomb });
}
const got = [...seen.values()];
console.log("accessories:", JSON.stringify(got));

/* ---- assertions ---- */
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "accessories.json"), "utf8"));
const byId = Object.fromEntries(cat.accessories.map((a) => [a.id, a]));
let fail = 0;
const check = (label, cond) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`); if (!cond) fail++; };

check("empty slots are skipped", got.length === 4);
check("duplicate collapses to one entry", got.filter((g) => g.id === "ZOMBIE_TALISMAN").length === 1);
check("the recombobulated copy wins", got.find((g) => g.id === "ZOMBIE_TALISMAN").recomb === true);
check("recombobulated flag read from NBT", got.find((g) => g.id === "ABICASE").recomb === true);
check("non-recombobulated reads false", got.find((g) => g.id === "HEGEMONY_ARTIFACT").recomb === false);
check("unknown ids survive decode (filtered later by catalogue)", !!got.find((g) => g.id === "NOT_A_REAL_ACCESSORY"));
check("every known id resolves in the catalogue",
  got.filter((g) => byId[g.id]).length === 3);

// and the power the site would report for that bag
const MP = require("../mp.js");
const idx = MP.index(cat);
const owned = {};
for (const g of got) if (idx.byId[g.id]) owned[g.id] = { recomb: g.recomb };
const ev = MP.evaluate(idx, owned, { contacts: 40 });
console.log(`\nthat bag scores ${ev.total} AP at 40 contacts (multiplier x${ev.multiplier.toFixed(2)})`);
// Zombie Talisman recombobulated: Common->Uncommon = 5. Hegemony 16 doubled = 32.
// Abicase recombobulated Rare->Epic = 12, +20 from 40 contacts = 32.
check("power matches the rules by hand (5 + 32 + 32 = 69)", ev.total === 69);

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks passed");
process.exit(fail ? 1 : 0);
