# Skyshard Companion

A desktop companion for the Steam game Skyshard. It reads your island from the game's log and tells you which units and shops fit your board.

## Run it

```
npm install
npm start
```

The app watches `%APPDATA%\Project SkyShard\logs\godot.log`. If your log is somewhere else, use **Choose log file…**.

## What it shows

- **My island / Last opponent**: the board from the latest `Current build:` and `Opponent Board:` lines in the log. Click a unit for its details.
- **Units to look for**: shop units scored by the game's own synergy lists (`SynergyUnits`), counted both ways. Hover one to light up the units it works with.
- **Shop picks**: each unit shop's possible rolls (cost, tiers, faction/role/type filter, conditional unlocks), ranked by the chance it offers one of your top 15 suggestions. Units at a shop's top tier count double, as the game weights them.
- **Latest shop**: reads the shop you open in the game straight from the screen, marks the best pick for your board, and adds the unit you take to "Bought this round". If you take a unit before the shop settles, it is read from the last full-shop frame instead, and the panel keeps the shop's options after it closes so you can pick or correct the unit by hand. See below.
- **Bought this round**: the log only updates between rounds, so add mid-round purchases here. The list clears when the next board arrives.
- **Unlocked in shops**: conditional units your board has made available.

## Build a Windows app

```
npm run dist
```

This makes `dist/SkyshardCompanion-<version>.exe`, a single file that runs without installing Node or Git. Upload it to a GitHub release to share it. Windows may warn about it the first time because it isn't signed: **More info**, then **Run anyway**.

## Data

Unit and shop data comes from [SkyShard-Public](https://github.com/ItsBen321/SkyShard-Public). A copy for patch 1.1.0 ships in `data/game-data.json`. On start the app checks the repo and downloads newer data when the patch number changes. To rebuild the bundled copy from a checkout:

```
npm run data -- path/to/SkyShard-Public/game_info
```

Build codes are decoded as described by aaronlake's SkyShard Ranked Tracker: base64url, gunzip, then 32-bit integers laid out as `[header, 6n, x×n, y×n, unitId×n, enchant×3n]`.

## Tests

```
npm test
```
