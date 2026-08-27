# Accessory Power Ledger

**Live site: <https://goofturtles.github.io/skyblock-mp/>**

Prices load instantly from a committed snapshot; hit **Live prices** and it pulls current
Auction House BIN listings for all 305 tradeable accessories in about 20 seconds, straight
from the browser. No API key, no server.

Tells you the **cheapest Accessory Power in Hypixel SkyBlock right now** — which accessories to buy,
in what order, what the top tier of each family costs, and what the best shopping list is for a given
budget. Prices come live from the Auction House on every load.

"Magical Power" is what the game used to call it; it's Accessory Power now. Same thing.

```bash
node server.js
```

Then open <http://localhost:3512>. The local server additionally sweeps all 47 Auction House
pages itself, which is the most complete price source of the three.

Rebuild the two pages after editing anything in `artifact/`:

```bash
node build-local.js && node build-artifact.js
```

## What it does

| Tab | Answers |
| --- | --- |
| **Cheapest power** | Every purchase that raises your power, sorted by coins per point. This is the buy order. |
| **Max tier** | The highest tier of each family that's actually listed, and what reaching it costs. |
| **Budget plan** | "I have 250m" → the exact shopping list, total spend, and the multiplier you end at. |
| **Earn these** | Power that isn't for sale at any price. Free, but you have to go get it. |
| **Free wins** | Abiphone contacts, the Rift Prism, dead duplicates in your bag, recombobulation, the Crux trap. |
| **My bag** | Tick what you own. Saved in the browser. |

## Loading a bag by username

Type a username, hit **Load my bag**, and it ticks every accessory you hold.

Hypixel only serves profile contents to a key holder — there is no keyless route to a player's
accessory bag any more (SkyCrypt's public API is behind a WAF, and Soopy's parsed profiles drop the
bag). So the username lookup needs a **free Hypixel API key** from
[developer.hypixel.net](https://developer.hypixel.net/dashboard): sign in with Minecraft, create an
app, paste the key into "API key…".

The key is kept in your browser's localStorage and sent straight to Hypixel — it never touches this
server. The player also has to have **Inventory API** switched on (`/api` in SkyBlock → API
Settings), or the bag comes back empty even with a valid key.

**Without a key everything else still works** — tick what you own in "My bag" and every ranking,
price and budget plan is live and correct.

## The power rules it implements

All verified against [hypixelskyblock.minecraft.wiki](https://hypixelskyblock.minecraft.wiki/w/Magical_Power)
(the official wiki shut down in July 2026):

- Power per rarity — Common 3, Uncommon 5, Rare 8, Epic 12, Legendary 16, Mythic 22, Special 3, Very Special 5.
- Only the **highest-power** accessory in an upgrade family counts; duplicates never stack.
- **Hegemony Artifact** grants double power (32, or 44 recombobulated).
- **Rift Prism** grants a flat 11 once imbued at Erihann — not its Rare 8.
- **Abicase** grants its rarity power *plus* 1 per 2 Abiphone contacts (up to about +43).
- **Celestial Starstone** grants **zero** power despite topping the Crux tree — the Crux Chronomicon
  below it gives 22, so "upgrading" costs you 22. The planner never recommends it and warns you if
  you hold it.
- **Recombobulator 3000** raises rarity one step, capped at Mythic (Divine isn't obtainable).
- Stat multiplier = `29.97 × (ln(0.0019 × AP + 1)) ^ 1.2`.
- Dungeon accessories count double inside dungeons; the figures shown are overworld power.

## Data sources — all public, no key

| Source | Used for |
| --- | --- |
| `api.hypixel.net/v2/resources/skyblock/items` | Every accessory and its rarity (423 of them) |
| `api.hypixel.net/v2/skyblock/auctions` | Live BIN prices — all 47 pages swept per refresh |
| `api.hypixel.net/v2/skyblock/bazaar` | Recombobulator 3000 price |
| NEU `constants/parents.json` | Accessory upgrade families |
| NEU `constants/abiphone.json` | Abiphone contact roster |
| `api.ashcon.app` | Username → UUID |

Auction items only carry their internal id inside gzipped NBT, so `server.js` decodes every BIN
accessory listing (~4,500 of them) to get exact ids *and* whether each one is recombobulated — which
is why the tool can price "buy it recombobulated" separately from "buy it and recombobulate it
yourself". Sweep takes about 4 seconds and is cached for 3 minutes.

## Files

    server.js            static host + /api/prices (auction sweep, NBT decode, cache)
    build-catalogue.js   regenerates data/accessories.json from Hypixel + NEU
    build-artifact.js    assembles dist/planner.html, one self-contained file
    build-local.js       assembles index.html with content-hashed asset URLs
    mp.js                the power engine — rules, offers, budget solver (no DOM)
    nbt.js               minimal NBT reader, works in Node and the browser
    artifact/shell.html  page markup, shared by both targets
    artifact/style.css   the one stylesheet
    artifact/ui.js       the one UI — reads inlined data or fetches it
    index.html           local page; same markup, external assets
    data/accessories.json  generated catalogue: 423 accessories, 167 families
    test/engine-check.js   engine regression check against live prices
    __probe.html         side-by-side 375px / 768px render, for the no-clipping check

There is **one** UI. `index.html` and `dist/planner.html` are the same markup with the
same `artifact/ui.js` behind them — the local page links the assets, the hosted build
inlines them. Edit `artifact/*`, then re-run `node build-artifact.js`.

Rerun `node build-catalogue.js` when Hypixel adds accessories.

Both builds take `--check`, which fails if the committed output is behind its sources — useful
before pushing, since a stale `index.html` would pin GitHub Pages to old asset hashes.

## Checking it still works

```bash
node test/engine-check.js
```

Prints the cheapest-power ranking, the budget solver at four budget levels, and asserts the special
cases (family collapsing, Hegemony doubling, Abicase contacts, Rift Prism, the Starstone). Needs the
server running for prices.

## Known limits

- The budget solver is greedy on coins-per-point, not a proven optimum. For a fixed budget it can be
  a point or two off the true best basket.
- Prices are lowest BIN. Auction-only listings and manipulated single listings are not filtered, so
  sanity-check anything that looks absurdly cheap.
- `IQ Point` / `Two IQ Point` are treated as separate accessories, which is what NEU's family data
  says; if the game actually treats them as one line, that's 3 power overcounted for Rift players.

## Hosted version

A self-contained build is published as an Artifact:
<https://claude.ai/code/artifact/94352869-cf40-4e7d-9b6e-5d61c636dca1> (private until you share it
from the page's share menu).

```bash
node build-artifact.js
```

That inlines the catalogue, a price snapshot and the engine into one `dist/planner.html`, so the
whole page renders offline. It is not request-free: the page still links Google Fonts and the
**Live prices** button reaches out. A published Artifact runs under a CSP that blocks every
external host, so on that copy the fonts fall back to the system stack and live prices are
refused. Consequences worth knowing:

- **Prices are a snapshot**, stamped on the page, not live. Re-run the snapshot command in the
  header of `build-artifact.js` and rebuild to refresh them.
- **The username lookup is not in the hosted build** — it needs calls to Hypixel, which the CSP
  blocks. Run the local server for that.
- Everything else — ranking, max tier, budget planner, free wins, ticking your bag — works fully
  offline, and what you tick is saved in your own browser.

The hosted build is deliberately dark-only: Minecraft rarity colours are calibrated for dark
grounds, and rarity here is data rather than decoration.
