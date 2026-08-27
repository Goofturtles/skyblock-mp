#!/usr/bin/env node
/**
 * Generates index.html — the same markup as the hosted build, but linking the
 * assets instead of inlining them.
 *
 *   node build-local.js
 *
 * Asset URLs carry a content hash. Static hosts (GitHub Pages included) serve
 * JS and CSS with a long max-age, so without this a visitor keeps running the
 * previous ui.js after a deploy while index.html itself looks up to date.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const here = (p) => path.join(__dirname, p);
const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(here(p))).digest("hex").slice(0, 8);

const shell = fs.readFileSync(here("artifact/shell.html"), "utf8");
const v = {
  css: hash("artifact/style.css"),
  engine: hash("mp.js"),
  ui: hash("artifact/ui.js"),
};

const body = shell
  .replace("<style>/*__CSS__*/</style>", `<link rel="stylesheet" href="artifact/style.css?v=${v.css}">`)
  .replace('<script>window.__CATALOGUE__ = /*__CATALOGUE__*/null; window.__PRICES__ = /*__PRICES__*/null;</script>', "")
  .replace("<script>/*__ENGINE__*/</script>", `<script src="mp.js?v=${v.engine}"></script>`)
  .replace("<script>/*__UI__*/</script>", `<script src="artifact/ui.js?v=${v.ui}"></script>`);

const split = body.indexOf("<header");
const out =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta name="description" content="Ranks every Hypixel SkyBlock accessory by coins per Accessory Power, live from the Auction House.">\n' +
  body.slice(0, split) +
  "</head>\n<body>\n" +
  body.slice(split) +
  "\n</body>\n</html>\n";

for (const token of ["/*__CSS__*/", "/*__ENGINE__*/", "/*__UI__*/", "__CATALOGUE__"]) {
  if (out.includes(token)) { console.error(`placeholder ${token} was never substituted`); process.exit(1); }
}

fs.writeFileSync(here("index.html"), out);
console.log(`wrote index.html  ${(out.length / 1024).toFixed(1)} KB  (css ${v.css}, engine ${v.engine}, ui ${v.ui})`);
