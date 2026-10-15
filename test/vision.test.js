const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const vision = require('../src/vision')
const data = require('../data/game-data.json')

const ART = path.join(__dirname, '..', 'unit-art')
const haveArt = fs.existsSync(path.join(ART, 'templates.bin')) && fs.existsSync(path.join(ART, 'fixtures'))
const skip = haveArt ? false : 'unit-art (game art) is not present'
const byId = new Map(data.units.map(u => [u.id, u]))
const name = id => data.units.find(u => u.id === id).name
const frame = f => ({ width: 1280, height: 720, data: zlib.gunzipSync(fs.readFileSync(path.join(ART, 'fixtures', `${f}.bgra.gz`))) })
let templates
const load = () => {
  templates = templates || vision.loadTemplates({ index: require(path.join(ART, 'index.json')).templates, bytes: fs.readFileSync(path.join(ART, 'templates.bin')) }, data.units)
  return templates
}

test('resize averages pixels', () => {
  const src = Uint8Array.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255])
  assert.deepStrictEqual([...vision.resize(src, 2, 2, 1, 1)], [100, 100, 100, 255])
})

const SHOPS = {
  '01-shop-3units-round4': ['Scarecrow', 'Watch Tower', 'Marketplace'],
  '02-basic-big-shop-round7': ['Crystal Mine', 'Town Hall', 'Grand Canopy', 'Bank', 'Stone Wall', 'Scarecrow'],
  '03-nature-shop-round7': ['Latchwood Spore', 'Towering Shadewood', 'Arborist'],
  '04-small-town-shop-round8': ['Micro Librarium']
}
for (const [shot, expected] of Object.entries(SHOPS)) {
  test(`reads shop ${shot}`, { skip }, () => {
    const f = frame(shot)
    assert.ok(vision.shopOpen(f))
    const shop = vision.readShop(vision.pyramid(f), load())
    assert.strictEqual(shop.size, expected.length)
    assert.deepStrictEqual(shop.slots.map(s => name(s.options[0].id)), expected)
  })
}

const emptyShop = () => ({ ...require(path.join(ART, 'empty-shop.json')), data: zlib.gunzipSync(fs.readFileSync(path.join(ART, 'empty-shop.bgra.gz'))) })

test('tells the shop layout from the units standing on the island', { skip }, () => {
  const empty = emptyShop()
  const layouts = {
    '01-shop-3units-round4': 3,
    '02-basic-big-shop-round7': 6,
    '04-small-town-shop-round8': 1,
    'live-22-20-12': 0, // empty island between shops
    'live-22-21-37': 0, // units still spawning in
    'live-22-21-39': 3,
    'live-22-21-56': 0, // after the pick, with a tooltip showing
    'live-22-58-gold-unit': 3, // a gold unit where a panel would show
    'live-23-48-missed': 3, // small units on the middle and right spots
    fight: 0, // the opponent's island during a fight
    'island-round11': 0
  }
  for (const [f, size] of Object.entries(layouts)) assert.strictEqual(vision.shopLayout(frame(f), empty), size, f)
})

const LIVE = {
  'live-22-21-39': ['Post Office', 'Derelict', 'Well'],
  'live-22-28-13': ['Mill', 'Foundry', 'Blacksmith'],
  'live-22-29-01': ['Magic Missile Mine', 'Dynamo', 'Mill'],
  'live-22-30-44': ['Scarecrow', 'Town Hall', 'Bakery', 'Stone Wall', 'Saloon', 'Artillery Repeater']
}
for (const [shot, expected] of Object.entries(LIVE)) {
  test(`reads shop ${shot} from a real game`, { skip }, () => {
    const shop = vision.readShop(vision.pyramid(frame(shot)), load(), expected.length, emptyShop())
    assert.deepStrictEqual(shop.slots.map(s => name(s.options[0].id)), expected)
  })
}

test('ignores frames where a unit card or the Tips panel covers the shop', { skip }, () => {
  const empty = emptyShop()
  for (const f of ['card-popup', 'tips-panel']) {
    assert.strictEqual(vision.shopLayout(frame(f), empty), 0, f)
    for (const size of [1, 3, 6]) {
      const filled = vision.slotsFilled(frame(f), empty, size)
      assert.ok(filled === null || filled.every(x => x !== false), `${f} must not look like an emptied shop`)
    }
  }
})

test('does not see a shop on other screens', { skip }, () => {
  assert.strictEqual(vision.shopOpen(frame('island-round11')), false)
  assert.strictEqual(vision.shopOpen(frame('library-open')), false)
})

test('reads the pick from where the mouse rested before dragging', () => {
  const shop = { size: 3, slots: vision.LAYOUTS[3] }
  // Mouse rests on the right unit, then drags it across the other two toward the player's island.
  const trail = [
    { t: 0, x: 1050, y: 340 },
    { t: 20, x: 1052, y: 338 },
    { t: 40, x: 1053, y: 338 },
    { t: 60, x: 990, y: 336 },
    { t: 80, x: 925, y: 338 },
    { t: 100, x: 860, y: 338 },
    { t: 120, x: 795, y: 338 },
    { t: 140, x: 600, y: 330 }
  ]
  assert.strictEqual(vision.pickFromTrail(shop, trail, 50, 150), 2)
  // No mouse over any unit: unknown.
  assert.strictEqual(vision.pickFromTrail(shop, [{ t: 150, x: 200, y: 200 }], 100, 200), -1)
})

test('reads the island grid when it shows, and only then', { skip }, () => {
  const tiles = vision.islandTiles(frame('island-grid'))
  assert.ok(tiles)
  assert.strictEqual(Object.keys(tiles).length, 264)
  // Empty ground on the right, taken tiles under the Saloons at the bottom.
  assert.strictEqual(tiles['5,-2'], '.')
  assert.strictEqual(tiles['2,7'], '#')
  // From the live video of a packed island, with Island Stats open: softer lines, most tiles covered.
  const live = vision.islandTiles(frame('island-grid-live'))
  assert.ok(live)
  assert.deepStrictEqual(['1,-8', '2,-8', '-3,0', '-2,0'].map(k => live[k]), ['.', '.', '.', '.'])
  assert.deepStrictEqual(['-4,-8', '-8,-4', '-5,6'].map(k => live[k]), ['#', '#', '#'])
  for (const f of ['live-22-21-39', 'live-22-58-gold-unit', 'fight', 'tips-panel', 'island-round11', '02-basic-big-shop-round7', '04-small-town-shop-round8']) assert.strictEqual(vision.islandTiles(frame(f)), null, f)
})

test('finds units on the island by their picture', { skip }, () => {
  const f = frame('island-grid')
  const id = n => data.units.find(u => u.name === n).id
  const found = vision.findOnIsland(f, vision.islandTiles(f), load(), new Map(data.units.map(u => [u.id, u])), ['Micro Librarium', 'Corrupt Alchemist', 'Spellbound Rocket'].map(id))
  const best = ['Micro Librarium', 'Corrupt Alchemist', 'Spellbound Rocket'].map(n => found.find(r => r.id === id(n)))
  assert.deepStrictEqual(best.map(r => [r.x, r.y]), [[0, 1], [1, -3], [-8, -2]])
  assert.ok(best.every(r => r.score > 0.8))
})

test('finds both bought trees on a packed island', { skip }, () => {
  const f = frame('island-two-trees')
  const tree = data.units.find(u => u.name === 'Tree').id
  const found = vision.findOnIsland(f, vision.islandTiles(f), load(), new Map(data.units.map(u => [u.id, u])), [tree, tree])
  assert.deepStrictEqual(found.slice(0, 2).map(r => `${r.x},${r.y}`).sort(), ['9,2', '9,3'])
  assert.ok(found[1].score >= 0.6 && found[1].score - found[2].score > 0.05)
})

test('reads the round counter', { skip }, () => {
  // island-grid-live, gold-unit, island-grid and missed weren't used to cut the digits.
  const rounds = { 'round-one': 1, 'live-22-30-44': 2, 'live-22-58-gold-unit': 5, 'island-grid': 7, 'island-round11': 11, 'island-grid-live': 12, 'live-23-48-missed': 14, 'island-two-trees': 15, 'round-one-one-portrait': 1, 'library-open': null }
  for (const [f, n] of Object.entries(rounds)) assert.strictEqual(vision.readRound(frame(f)), n, f)
  assert.strictEqual(vision.isRoundOne(frame('island-two-trees')), false)
})

test('finds new units on the island without the grid or any hints', { skip }, () => {
  const seen = vision.identifyOnIsland(frame('round-one'), load(), byId, vision.ISLAND_TILES.map(t => t.key))
  const spots = seen.map(s => `${name(s.id)}@${s.x},${s.y}`)
  for (const want of ['Red Sun Shrine@-8,0', 'Nurturing Sprite@1,7']) assert.ok(spots.includes(want), `${want} in ${spots}`)
})

test('the island watcher pauses when the camera leaves the home view', { skip }, () => {
  const IslandWatch = require('../src/island-watch')
  const watcher = IslandWatch.createWatcher(load(), byId)
  assert.strictEqual(watcher.read(frame('island-grid'), { pieces: [], hints: [] }).view, 'ok')
  assert.strictEqual(watcher.read(frame('fight'), { pieces: [], hints: [] }).view, 'moved')
  watcher.reset()
  assert.strictEqual(watcher.read(frame('fight'), { pieces: [], hints: [] }).view, 'unknown')
})

test('clouds drifting over the island when a shop comes in are not a camera move', { skip }, () => {
  // On the dark island, a shop's arrival brings banks of cloud over the island's corners; a sold Portal
  // stayed on the list for a minute while every reading said the camera had moved.
  const a = vision.cameraSample(frame('dark-island-stats'))
  assert.ok(vision.cameraMatch(a, vision.cameraSample(frame('shop-clouds'))) >= 0.8)
  assert.ok(vision.cameraMatch(a, vision.cameraSample(frame('fight'))) < 0.6)
})

test('a new run on the dark island is read before anything is dragged', { skip }, () => {
  const IslandWatch = require('../src/island-watch')
  const f = frame('dark-island-round-one')
  const watcher = IslandWatch.createWatcher(load(), byId)
  assert.strictEqual(watcher.read(f, { pieces: [], hints: [] }).view, 'ok')
  const seen = watcher.read(f, { pieces: [], hints: [] }).sightings.map(s => `${name(s.id)}@${s.x},${s.y}`).sort()
  assert.deepStrictEqual(seen, ['Grand Canopy@7,4', 'Red Sun Shrine@-8,-1'])
})

test('a sparse island gives no lookalikes on bare ground', { skip }, () => {
  const f = frame('sparse-round-one')
  const looks = vision.tileLooks(f)
  const ground = vision.ISLAND_TILES.map(t => t.key).filter(k => vision.groundLike(looks[k]))
  const open = vision.ISLAND_TILES.map(t => t.key).filter(k => !ground.includes(k))
  const spots = vision.identifyOnIsland(f, load(), byId, open, { blocked: ground }).map(s => `${name(s.id)}@${s.x},${s.y}`).sort()
  assert.deepStrictEqual(spots, ['Jeffrey@1,1', 'Muncher@5,7', 'Nurturing Sprite@1,7', 'Powerline@2,0', 'Red Sun Shrine@-8,-1', 'Town Hall@-2,4', 'Well@6,3', 'Well@6,5'])
})

test('small units are scored again on the full-size island when there is one', { skip }, () => {
  const f = frame('sparse-round-one')
  const hi = { scale: 2, x0: 80, y0: 200, width: 1120, height: 920, data: zlib.gunzipSync(fs.readFileSync(path.join(ART, 'fixtures', 'sparse-round-one-full.bgra.gz'))) }
  const id = n => data.units.find(u => u.name === n).id
  const pieces = [['Well', 6, 3], ['Jeffrey', 1, 1], ['Nurturing Sprite', 1, 7], ['Holos Replicator', 4, 7], ['Tree', 3, 4]].map(([n, x, y]) => ({ key: n, id: id(n), x, y }))
  const score = Object.fromEntries(vision.verifyOnIsland(f, load(), byId, pieces, hi).map(v => [v.key, v.score]))
  for (const n of ['Well', 'Jeffrey', 'Nurturing Sprite']) assert.ok(score[n] > 0.8, `${n} ${score[n]}`)
  for (const n of ['Holos Replicator', 'Tree']) assert.ok(score[n] < 0.45, `${n} ${score[n]}`)
  const seen = vision.identifyOnIsland(f, load(), byId, ['6,3', '6,5', '1,1', '1,7'], { hi }).map(s => `${name(s.id)}@${s.x},${s.y}`).sort()
  assert.deepStrictEqual(seen, ['Jeffrey@1,1', 'Nurturing Sprite@1,7', 'Well@6,3', 'Well@6,5'])
})

test('a small unit that blurs away at half size is still found with the full-size island', { skip }, () => {
  // The Carpenter's bench on the dark island, beside Jeffrey (1,-7).
  const f = frame('dark-island-carpenter')
  const hi = { scale: 2, x0: 80, y0: 200, width: 1120, height: 920, data: zlib.gunzipSync(fs.readFileSync(path.join(ART, 'fixtures', 'dark-island-carpenter-full.bgra.gz'))) }
  const seen = vision.identifyOnIsland(f, load(), byId, ['2,-7'], { blocked: ['1,-7'], hi }).map(s => `${name(s.id)}@${s.x},${s.y}`)
  assert.deepStrictEqual(seen, ['Carpenter@2,-7'])
})

test('a new unit is only reported once two reads in a row see it', { skip }, () => {
  const IslandWatch = require('../src/island-watch')
  const watcher = IslandWatch.createWatcher(load(), byId)
  const id = n => data.units.find(u => u.name === n).id
  const pieces = [['Red Sun Shrine', -8, -1], ['Nurturing Sprite', 1, 7], ['Town Hall', -2, 4]].map(([n, x, y]) => ({ key: n, id: id(n), x, y }))
  const f = frame('sparse-round-one')
  assert.deepStrictEqual(watcher.read(f, { pieces }).sightings, [])
  const second = watcher.read(f, { pieces }).sightings.map(s => `${name(s.id)}@${s.x},${s.y}`).sort()
  assert.deepStrictEqual(second, ['Jeffrey@1,1', 'Muncher@5,7', 'Powerline@2,0', 'Well@6,3', 'Well@6,5'])
})

test('a unit\'s card is found, and the unit it names is found under it', { skip }, () => {
  const f = frame('card-bee-hive')
  const box = vision.unitCard(f)
  assert.ok(box && Math.abs(box.x0 - 124) <= 6 && Math.abs(box.x1 - 403) <= 6 && Math.abs(box.y1 - 356) <= 6, JSON.stringify(box))
  const title = vision.cardTitle(f, box)
  assert.strictEqual(title.data.length, title.width * title.height)
  const units = new Map(data.units.map(u => [u.id, u]))
  const hive = data.units.find(u => u.name === 'Bee Hive').id
  for (const cursor of [null, { x: 262, y: 416 }, { x: 262, y: 395 }]) {
    const [best, next] = vision.locateCardUnit(f, load(), units, hive, box, cursor)
    assert.deepStrictEqual([best.x, best.y], [-1, 2])
    assert.ok(best.score >= 0.5 && (!next || best.score - next.score >= 0.1))
  }
  // The mouse off the island: not an island unit's card.
  assert.deepStrictEqual(vision.locateCardUnit(f, load(), units, hive, box, { x: 900, y: 300 }), [])
  // Other cards (random unit packs) are found too; their titles don't name a unit.
  for (const other of ['card-random-magic', 'card-random-house']) assert.ok(vision.unitCard(frame(other)), other)
  // A card whose row of tags sits over sandy ground: the ground joins it, but the card is still found.
  const ruby = vision.unitCard(frame('card-ruby-over-island'))
  assert.ok(ruby && ruby.x0 === 0 && ruby.y0 === 176 && Math.abs(ruby.y1 - 290) <= 6, JSON.stringify(ruby))
  // A Tinker unit's card: its tags are brown, like the card's text, but solid.
  const dynamo = vision.unitCard(frame('card-dynamo-tinker'))
  assert.ok(dynamo && Math.abs(dynamo.x0 - 32) <= 6 && Math.abs(dynamo.y1 - 187) <= 6, JSON.stringify(dynamo))
  // A Basic unit's card (Post Office, in the shop): its tags are plain grey.
  const post = vision.unitCard(frame('live-22-21-56'))
  assert.ok(post && Math.abs(post.x0 - 640) <= 6 && Math.abs(post.y1 - 287) <= 6, JSON.stringify(post))
  // A card pushed up against the bar along the top of the screen, which touches it.
  const cell = vision.unitCard(frame('card-power-cell-top'))
  assert.ok(cell && Math.abs(cell.x0 - 188) <= 6 && Math.abs(cell.y1 - 191) <= 6, JSON.stringify(cell))
  // A card whose top touches a unit above it (the Soul Engine's logs over a Well's card).
  const well = vision.unitCard(frame('card-well-under-logs'))
  assert.ok(well && Math.abs(well.x0 - 28) <= 6 && Math.abs(well.y0 - 248) <= 6, JSON.stringify(well))
  // A weapon's stat boxes beside its text leave only about two thirds of the card parchment.
  const saber = vision.unitCard(frame('card-solaris-saber-stats'))
  assert.ok(saber && Math.abs(saber.x0 - 916) <= 6 && Math.abs(saber.y0 - 152) <= 6, JSON.stringify(saber))
  // Enchantment icons on the card (Big Laser Pointer), with the unit's big panel open beside it.
  const laser = vision.unitCard(frame('card-laser-enchanted'))
  assert.ok(laser && Math.abs(laser.x0 - 0) <= 6 && Math.abs(laser.y0 - 196) <= 6, JSON.stringify(laser))
  const both = vision.unitCard(frame('card-saber-enchanted'))
  assert.ok(both && Math.abs(both.x0 - 56) <= 6 && Math.abs(both.y0 - 48) <= 6, JSON.stringify(both))
  // The big unit panel and plain frames aren't cards.
  for (const none of ['big-card-panel', '01-shop-3units-round4', '02-basic-big-shop-round7']) assert.strictEqual(vision.unitCard(frame(none)), null, none)
})

test('a tall picture is looked for above its tiles, so the Big Tree is found on its own row', () => {
  // The Big Tree stands on the bottom row (its tiles end at y 7); its picture reaches about 17 px
  // above the tiles' middle, which used to fit better one row up.
  const units = new Map(data.units.map(u => [u.id, u]))
  const spots = [7, 6].map(y => ({ key: `7@-3,${y}`, id: 7, x: -3, y }))
  const [low, high] = vision.verifyOnIsland(frame('island-big-tree-bottom'), load(), units, spots)
  assert.ok(low.score > 0.85, `on its row ${low.score}`)
  assert.ok(low.score - high.score >= 0.1, `one row up ${high.score}`)
})

test('a hovered unit is looked for only where its picture would cover the mouse', () => {
  // A Tree half hidden by bamboo; another Tree three rows down used to compete with it.
  const units = new Map(data.units.map(u => [u.id, u]))
  const f = frame('card-tree-hover')
  const spots = vision.locateCardUnit(f, load(), units, 35, vision.unitCard(f), { x: 421.5, y: 363 })
  assert.deepStrictEqual([spots[0].x, spots[0].y], [5, 0])
  assert.ok(spots[0].score > 0.7, `score ${spots[0].score}`)
  assert.ok(spots.every(s => s.y < 2), JSON.stringify(spots))
  assert.ok(!spots[1] || spots[0].score - spots[1].score >= 0.1, JSON.stringify(spots))
})
