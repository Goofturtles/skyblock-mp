const fs = require("fs");
const path = require("path");
const MP = require("../mp.js");

const cat = MP.index(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "accessories.json"), "utf8")));
const prices = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "prices-snapshot.json"), "utf8"));
let fail = 0;
const check = (label, cond, extra) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); if (!cond) fail++; };

/* ---------- 1. requirements ---------- */
console.log("REQUIREMENTS");
const tarantulaRing = cat.byId.TARANTULA_RING;
check("Tarantula Ring is gated", !!tarantulaRing.req);
const none = MP.requirementStatus(tarantulaRing, {});
check("locked with no progress declared", !none.met, none.needs.join(", "));
const some = MP.requirementStatus(tarantulaRing, { slayer: { spider: 6 } });
check("still locked one level short", !some.met, some.needs.join(", "));
const enough = MP.requirementStatus(tarantulaRing, { slayer: { spider: 7 } });
check("unlocked at the required level", enough.met);

const phd = cat.accessories.find((a) => a.id === "PHD_GRIMOIRE");
check("trophy gate reads as human text",
  MP.requirementStatus(phd, { trophy: { FROG: "GOLD" } }).needs.some((n) => /diamond/.test(n)),
  MP.requirementStatus(phd, { trophy: { FROG: "GOLD" } }).needs.join(", "));
check("trophy gate opens at the right tier", MP.requirementStatus(phd, { trophy: { FROG: "DIAMOND" } }).met);

const titanium = cat.accessories.find((a) => a.id === "TITANIUM_RELIC");
check("HOTM gate honoured", !MP.requirementStatus(titanium, { hotm: 4 }).met && MP.requirementStatus(titanium, { hotm: 5 }).met);
check("ungated accessories are always met", MP.requirementStatus(cat.byId.ZOMBIE_TALISMAN, {}).met);

/* ---------- 2. locked offers are marked ---------- */
console.log("\nLOCKED OFFERS");
const noProgress = MP.offers(cat, {}, prices, { contacts: 0, progress: {} });
const lockedCount = noProgress.filter((o) => o.locked).length;
check("some offers come back locked", lockedCount > 0, lockedCount + " locked");
const maxed = MP.offers(cat, {}, prices, { contacts: 0, progress: {
  slayer: { zombie: 9, spider: 9, wolf: 9, enderman: 9, blaze: 9, vampire: 9 }, hotm: 10,
  trophy: { FROG: "DIAMOND", LAVA: "DIAMOND" } } });
check("a maxed player has nothing locked", maxed.filter((o) => o.locked).length === 0);
check("unlocking never removes offers", maxed.length === noProgress.length);

/* ---------- 3. one row per family ---------- */
console.log("\nONE ROW PER FAMILY");
const fams = noProgress.map((o) => o.family);
check("raw offers do repeat families", new Set(fams).size < fams.length,
  `${fams.length} offers over ${new Set(fams).size} families`);
const collapsed = MP.bestPerFamily(noProgress);
const cf = collapsed.map((o) => o.family);
check("collapsed list has one row per family", new Set(cf).size === cf.length);
check("collapsed rows keep the best rate", collapsed.every((o) =>
  noProgress.filter((x) => x.family === o.family).every((x) => x.coinsPerMp >= o.coinsPerMp)));
check("collapsed rows say how high the family goes", collapsed.every((o) => o.familyTopMp >= o.toMp));
const multi = collapsed.find((o) => o.familyTopMp > o.toMp);
if (multi) console.log(`     e.g. ${multi.name}: buy at ${multi.toMp} AP, family tops out at ${multi.familyTopMp}`);

/* ---------- 4. slot plan ---------- */
console.log("\nSLOT PLAN");
const owned = {
  ZOMBIE_TALISMAN: { recomb: false },   // outranked by the artifact below
  ZOMBIE_ARTIFACT: { recomb: false },
  CRUX_TALISMAN_7: { recomb: false },   // Celestial Starstone: 0 AP
  BAT_RING: { recomb: false },
};
const plan = MP.slotPlan(cat, owned, prices, { contacts: 0, progress: {} });
const deadIds = plan.dead.map((d) => d.id);
check("spots the outranked duplicate", deadIds.includes("ZOMBIE_TALISMAN"),
  plan.dead.filter(d=>d.id==="ZOMBIE_TALISMAN").map(d=>`beaten by ${d.beatenBy}`)[0]);
check("spots the zero-power Starstone", deadIds.includes("CRUX_TALISMAN_7"));
check("does not flag a useful accessory", !deadIds.includes("BAT_RING") && !deadIds.includes("ZOMBIE_ARTIFACT"));
check("counts the freed slots", plan.freed === plan.dead.length && plan.freed === 2, `freed ${plan.freed}`);
check("suggests one replacement per freed slot", plan.fills.length === plan.freed, `${plan.fills.length} fills`);
check("replacements are all different families", new Set(plan.fills.map((f) => f.family)).size === plan.fills.length);
check("replacements are never locked", plan.fills.every((f) => !f.locked));
console.log(`     freeing ${plan.freed} slots (${plan.deadPower} dead AP) and refilling gains +${plan.gain} AP for ${Math.round(plan.spend/1e6)}M`);

const gated = MP.slotPlan(cat, owned, prices, { contacts: 0, progress: {
  slayer: { zombie: 9, spider: 9, wolf: 9, enderman: 9, blaze: 9, vampire: 9 }, hotm: 10,
  trophy: { FROG: "DIAMOND", LAVA: "DIAMOND" } } });
check("a maxed player gets at least as good a refill", gated.gain >= plan.gain, `${plan.gain} -> ${gated.gain}`);

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks passed");
process.exit(fail ? 1 : 0);
