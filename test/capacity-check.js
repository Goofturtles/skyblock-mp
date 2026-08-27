const fs = require("fs"), path = require("path"), MP = require("../mp.js");
const cat = MP.index(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "accessories.json"), "utf8")));
const prices = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "prices-snapshot.json"), "utf8"));
let fail = 0;
const check = (l, c, x) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${l}${x ? "  — " + x : ""}`); if (!c) fail++; };

// a small, full bag: 4 accessories, capacity 4, nothing wasted
const owned = {
  FEATHER_TALISMAN: { recomb: false },   // weak
  ZOMBIE_TALISMAN: { recomb: false },    // weak
  BAT_RING: { recomb: false },
  HEGEMONY_ARTIFACT: { recomb: false },  // strong
};
const opts = { contacts: 0, progress: {}, capacity: 4 };

console.log("FULL BAG");
const p = MP.capacityPlan(cat, owned, prices, opts);
check("knows it is full", p.full === true, `held ${p.held}/${p.capacity}, free ${p.free}`);
check("offers swaps rather than plain additions", p.swaps.length > 0, `${p.swaps.length} swaps`);
check("every swap is a net gain", p.swaps.every((sw) => sw.netGain > 0));
check("each swap names what it displaces", p.swaps.every((sw) => sw.replaces && sw.replaces.name));
check("nothing is displaced twice", new Set(p.swaps.map((sw) => sw.replaces.id)).size === p.swaps.length);
check("it displaces the weakest first",
  p.swaps.every((sw) => sw.replaces.mp <= Math.max(...Object.keys(owned).map((id) => MP.powerOf(cat, cat.byId[id], false, 0)))));
check("never displaces the strongest holding",
  !p.swaps.some((sw) => sw.replaces.id === "HEGEMONY_ARTIFACT"));
const top = p.swaps[0];
console.log(`     best swap: out ${top.replaces.name} (${top.replaces.mp} AP), in ${top.name} (${top.toMp} AP) = net +${top.netGain}`);

console.log("\nSLOT-NEUTRAL UPGRADES");
check("upgrades exist and are slot-neutral", p.upgrades.length > 0 && p.upgrades.every((o) => o.fromMp > 0),
  `${p.upgrades.length} upgrades`);
check("upgrades are offered even though the bag is full", p.full && p.upgrades.length > 0);

console.log("\nROOM TO SPARE");
const roomy = MP.capacityPlan(cat, owned, prices, { ...opts, capacity: 40 });
check("not flagged full", roomy.full === false, `free ${roomy.free}`);
check("free slots counted correctly", roomy.free === 40 - roomy.held, `${roomy.free}`);

console.log("\nDEAD WEIGHT COUNTS AS SPACE");
const withDead = { ...owned, ZOMBIE_ARTIFACT: { recomb: false } };  // outranks the talisman
const dw = MP.capacityPlan(cat, withDead, prices, { ...opts, capacity: 5 });
check("spots the now-dead talisman", dw.dead.some((d) => d.id === "ZOMBIE_TALISMAN"));
check("reclaimable dead weight frees a slot", dw.free >= 1, `free ${dw.free} at 5/5 held`);
check("so a full-looking bag is not actually full", dw.full === false);

console.log("\nUNDECLARED CAPACITY");
const unknown = MP.capacityPlan(cat, owned, prices, { ...opts, capacity: 0 });
check("treated as unlimited", unknown.full === false && unknown.free === null);
check("no swaps forced on someone who never said", unknown.swaps.length >= 0);

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks passed");
process.exit(fail ? 1 : 0);
