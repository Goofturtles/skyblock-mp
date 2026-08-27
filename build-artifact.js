#!/usr/bin/env node
/**
 * Assembles dist/planner.html — a single page with the accessory catalogue, a price
 * snapshot and the power engine all inlined, so it needs no server and renders its
 * full content offline.
 *
 * It is not request-free: the shell links Google Fonts, and the "Live prices" button
 * reaches the Auction House. Both degrade cleanly — the type falls back to the system
 * stack, and blocked prices leave the snapshot in place.
 *
 *   node build-artifact.js
 *
 * Refresh data/prices-snapshot.json first (server running):
 *   node -e "fetch('http://localhost:3512/api/prices').then(r=>r.json()).then(p=>require('fs').writeFileSync('data/prices-snapshot.json',JSON.stringify({generated:p.generated,recombobulator:p.recombobulator,lowestBin:p.lowestBin})))"
 */
const fs = require("fs");
const path = require("path");

const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

const catalogue = JSON.parse(read("data/accessories.json"));
const snapshot = JSON.parse(read("data/prices-snapshot.json"));
const engine = read("mp.js");
const nbt = read("nbt.js");
const shell = read("artifact/shell.html");
const ui = read("artifact/ui.js");
const css = read("artifact/style.css");

// The engine is a UMD module; inside the page it just needs to define window.MP.
// Item names come from Hypixel's API, and JSON.stringify does not escape `<`. Without
// this, a name containing `</script` would break out of the tag it is embedded in.
const embed = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

// The Artifact host supplies its own <head> and drops a stray one, but a standalone copy
// of this file needs the charset (or "Can't buy" and "×" mojibake under file://) and a
// lang attribute.
const head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
  + '<meta name="description" content="Ranks every Hypixel SkyBlock accessory by coins per Accessory Power.">\n'
  + '</head>\n<body>\n';

// css/nbt/mp/ui go in raw — JSON escaping cannot help them. A literal `</script` or
// `</style` in any of them would close its tag early and silently break the page.
for (const [name, text] of [["style.css", css], ["nbt.js", nbt], ["mp.js", engine], ["ui.js", ui]]) {
  const stray = text.match(/<\/\s*(script|style)/i);
  if (stray) {
    console.error(`${name} contains ${stray[0]}, which would terminate its tag when inlined`);
    process.exit(1);
  }
}

// Each placeholder swallows the `null` after it, so the shell stays valid JS on its own.
const out = head + shell
  .replace("/*__CSS__*/", () => css)
  .replace("/*__CATALOGUE__*/null", () => embed(catalogue))
  .replace("/*__PRICES__*/null", () => embed(snapshot))
  .replace("/*__NBT__*/", () => nbt)
  .replace("/*__ENGINE__*/", () => engine)
  .replace("/*__UI__*/", () => ui);

for (const token of ["/*__CSS__*/", "/*__CATALOGUE__*/", "/*__PRICES__*/", "/*__NBT__*/", "/*__ENGINE__*/", "/*__UI__*/"]) {
  if (out.includes(token)) { console.error(`placeholder ${token} was never substituted`); process.exit(1); }
}

// Read the data before writing anything, so malformed input fails the build instead of
// leaving a broken artifact on disk.
const accessories = catalogue.accessories.length;
const families = Object.keys(catalogue.families).length;
const listings = Object.keys(snapshot.lowestBin).length;
const taken = new Date(snapshot.generated).toISOString();

const dst = path.join(__dirname, "dist", "planner.html");

// `--check` mirrors build-local.js: fails when the committed artifact is behind its sources.
if (process.argv.includes("--check")) {
  const current = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : "";
  if (current !== out) {
    console.error("dist/planner.html is stale — run `node build-artifact.js`");
    process.exit(1);
  }
  console.log("dist/planner.html is up to date");
  process.exit(0);
}

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.writeFileSync(dst, out);

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`wrote dist/planner.html  ${kb(Buffer.byteLength(out, "utf8"))}`);
console.log(`  catalogue ${accessories} accessories, ${families} families`);
console.log(`  prices    ${listings} listings, taken ${taken}`);
