#!/usr/bin/env node
/**
 * Assembles dist/planner.html — a single self-contained page with the accessory
 * catalogue, a price snapshot and the power engine all inlined, so it works with
 * no server and no network.
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

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
const dst = path.join(__dirname, "dist", "planner.html");
fs.writeFileSync(dst, out);

const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`wrote dist/planner.html  ${kb(out.length)}`);
console.log(`  catalogue ${catalogue.accessories.length} accessories, ${Object.keys(catalogue.families).length} families`);
console.log(`  prices    ${Object.keys(snapshot.lowestBin).length} listings, taken ${new Date(snapshot.generated).toISOString()}`);
