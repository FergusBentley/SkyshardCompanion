# Skyshard Companion

A desktop companion for the Steam game Skyshard. It reads your island from the game's log after every round and tells you which units and shops fit your board.

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

## Shop reading

A hidden window watches a live video of the game window (any window whose title contains "SkyShard") and checks it 10 times a second. The shop island stays on screen, empty, between shops. A shop counts as open once a full set of units (1, 3 or 6) stands on it and has finished spawning in, compared against a picture of the empty island (`unit-art/empty-shop.*`). It counts as closed once they're all gone. The opponent's island in combat doesn't count, and neither does a unit's tooltip.

That frame is read in the background, and the app lists up to 5 likely units for each slot. Picking a unit closes the shop at once, so the app tells which one you took from where your mouse was as the shop closed. It assumes the game fills the screen it's on. If the app gets the pick wrong, press **Took this** on the right unit. If it isn't sure what a unit is, choose from its guesses or type the name.

Recognition compares the screen with each unit's picture from the in-game library (`src/vision.js`). A unit's size on screen follows its footprint, about 26 px per tile at 1280x720. It needs the game in a 16:9 fullscreen or borderless window, with the default camera.

**Shop pictures** opens the folder of the last 60 shops. Each picture comes with a `.json` file listing what the app read, the mouse path, and any corrections you made. Send a few of these to tune recognition against real games.

The unit pictures live in `unit-art/`. They are the game's own art, so that folder keeps itself out of git.

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
