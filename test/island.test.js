const test = require('node:test')
const assert = require('node:assert')
const core = require('../src/core')

const units = [
  { id: 1, name: 'Hut', w: 1, h: 1 },
  { id: 2, name: 'Hall', w: 2, h: 2 },
  { id: 3, name: 'Tower', w: 1, h: 2 }
]
const byId = core.indexUnits(units)
const build = [{ id: 1, x: 0, y: 0, enchants: [] }, { id: 2, x: 3, y: 1, enchants: [] }]
const start = () => core.mergeLog([], build, byId, 0)
const ids = roster => roster.map(p => `${p.id}@${p.x},${p.y}`).sort()

// Every island tile, all '.' except those given.
function grid (marks = {}) {
  const tiles = {}
  core.ISLAND_ROWS.forEach((width, r) => {
    const s = (core.ISLAND_COLS - width) / 2 - core.ISLAND_OFFSET
    for (let x = s; x < s + width; x++) tiles[`${x},${r - core.ISLAND_OFFSET}`] = '.'
  })
  return Object.assign(tiles, marks)
}
const hallTiles = { '3,1': '#', '4,1': '?', '3,0': '#', '4,0': '#' }
const reading = r => ({ view: 'ok', grid: null, stats: false, covered: [], ground: [], verified: [], sightings: [], ...r })

test('footprints reach right and up from the unit\'s tile', () => {
  assert.deepStrictEqual(core.footprint(3, 1, 2, 2).sort(), ['3,0', '3,1', '4,0', '4,1'])
})

test('the log\'s board fills only tiles nobody holds', () => {
  const roster = core.mergeLog([{ key: 'x', id: 3, x: 0, y: 1, how: 'seen', at: 5 }], build, byId, 9)
  assert.deepStrictEqual(ids(roster), ['2@3,1', '3@0,1'])
})

test('with the grid up, a unit whose tiles show empty is taken off', () => {
  const { roster, removed } = core.trackIsland(start(), reading({ grid: grid({ ...hallTiles }) }), byId)
  assert.deepStrictEqual(ids(roster), ['2@3,1'])
  assert.deepStrictEqual(ids(removed), ['1@0,0'])
})

test('without the grid, a unit goes only when its tiles are bare and its picture is gone', () => {
  const pieces = start()
  const hut = pieces.find(p => p.id === 1).key
  // Bare tile but the picture still matches (a flat unit): stays.
  assert.strictEqual(core.trackIsland(pieces, reading({ ground: ['0,0'], verified: [{ key: hut, score: 0.6 }] }), byId).roster.length, 2)
  // Picture gone but the tile isn't bare (an animated unit, a neighbour's roof): stays.
  assert.strictEqual(core.trackIsland(pieces, reading({ ground: [], verified: [{ key: hut, score: 0.2 }] }), byId).roster.length, 2)
  // Both: gone.
  assert.deepStrictEqual(ids(core.trackIsland(pieces, reading({ ground: ['0,0'], verified: [{ key: hut, score: 0.2 }] }), byId).roster), ['2@3,1'])
  // Under the inventory panel nothing can be told.
  assert.strictEqual(core.trackIsland(pieces, reading({ ground: ['0,0'], covered: ['0,0'], verified: [{ key: hut, score: 0.2 }] }), byId).roster.length, 2)
})

test('a new unit is added where nothing stands, and replaces a unit that no longer matches', () => {
  const pieces = start()
  const hall = pieces.find(p => p.id === 2).key
  const added = core.trackIsland(pieces, reading({ sightings: [{ id: 3, x: 6, y: 3, score: 0.7 }] }), byId, 7)
  assert.deepStrictEqual(ids(added.roster), ['1@0,0', '2@3,1', '3@6,3'])
  assert.strictEqual(added.added[0].how, 'seen')
  // On the Hall's tiles: only if the Hall doesn't look like itself anymore.
  const onHall = { id: 3, x: 3, y: 1, score: 0.7 }
  assert.strictEqual(core.trackIsland(pieces, reading({ sightings: [onHall], verified: [{ key: hall, score: 0.6 }] }), byId).roster.length, 2)
  const swapped = core.trackIsland(pieces, reading({ sightings: [onHall], verified: [{ key: hall, score: 0.2 }] }), byId)
  assert.deepStrictEqual(ids(swapped.roster), ['1@0,0', '3@3,1'])
  assert.deepStrictEqual(ids(swapped.removed), ['2@3,1'])
  // Island Stats draws enchantments over units: no swaps then.
  assert.strictEqual(core.trackIsland(pieces, reading({ stats: true, sightings: [onHall], verified: [{ key: hall, score: 0.2 }] }), byId).roster.length, 2)
})

test('a unit that moved leaves its old spot and shows at the new one', () => {
  const tiles = grid({ '0,0': '#', '6,3': '#', '6,2': '#' })
  const { roster } = core.trackIsland(start(), reading({ grid: tiles, sightings: [{ id: 2, x: 6, y: 3, score: 0.8 }] }), byId)
  // The Hall's sighting at 6,3 needs 7,3 and 7,2 too, which show empty: not placed there.
  assert.deepStrictEqual(ids(roster), ['1@0,0'])
  const tiles2 = grid({ '0,0': '#', '6,3': '#', '6,2': '#', '7,3': '#', '7,2': '?' })
  assert.deepStrictEqual(ids(core.trackIsland(start(), reading({ grid: tiles2, sightings: [{ id: 2, x: 6, y: 3, score: 0.8 }] }), byId).roster), ['1@0,0', '2@6,3'])
})

test('nothing changes when the view has moved or is unknown', () => {
  const pieces = start()
  for (const view of ['moved', 'unknown']) assert.strictEqual(core.trackIsland(pieces, { view }, byId).roster, pieces)
})

test('a unit put down by hand replaces what was there and isn\'t swapped out by a sighting', () => {
  const placed = core.placePiece(start(), 3, 3, 1, byId, 5)
  assert.deepStrictEqual(ids(placed.roster), ['1@0,0', '3@3,1'])
  assert.deepStrictEqual(ids(placed.removed), ['2@3,1'])
  const after = core.trackIsland(placed.roster, reading({ sightings: [{ id: 1, x: 3, y: 1, score: 0.9 }] }), byId)
  assert.deepStrictEqual(ids(after.roster), ['1@0,0', '3@3,1'])
  // Unless its picture is plainly not there: then it was put on the wrong tile.
  const wrong = core.trackIsland(placed.roster, reading({ verified: [{ key: '3@3,1', score: 0.05 }, { key: '1@0,0', score: 0.9 }], sightings: [{ id: 1, x: 3, y: 1, score: 0.7 }] }), byId)
  assert.deepStrictEqual(ids(wrong.roster), ['1@0,0', '1@3,1'])
})

test('a unit put down by hand gives way like any other once its picture has matched clearly', () => {
  const placed = core.placePiece(start(), 3, 3, 1, byId, 5).roster
  // Matched clearly on one reading, so the app can read its picture.
  const seen = core.trackIsland(placed, reading({ verified: [{ key: '3@3,1', score: 0.8 }] }), byId).roster
  assert.strictEqual(seen.find(p => p.key === '3@3,1').seen, true)
  const swapped = core.trackIsland(seen, reading({ verified: [{ key: '3@3,1', score: 0.4 }, { key: '1@0,0', score: 0.9 }], sightings: [{ id: 1, x: 3, y: 1, score: 0.9 }] }), byId)
  assert.deepStrictEqual(ids(swapped.roster), ['1@0,0', '1@3,1'])
  // And its picture plainly gone three times in a row means it went.
  let r = seen
  for (let i = 0; i < 3; i++) r = core.trackIsland(r, reading({ verified: [{ key: '3@3,1', score: 0.1 }] }), byId).roster
  assert.deepStrictEqual(ids(r), ['1@0,0'])
})

test('bought units count as placed once one of them turns up', () => {
  const roster = [...start(), { key: 'a', id: 1, x: 5, y: 5, how: 'seen', at: 100 }]
  assert.deepStrictEqual(core.unplacedBought(roster, [1, 1, 3], 50), [1, 3])
  assert.deepStrictEqual(core.unplacedBought(roster, [1], 200), [1])
})

test('Tree and Vinculi come with a copy when bought', () => {
  const data = require('../data/game-data.json')
  const twice = data.units.filter(u => core.copiesPerBuy(u) === 2).map(u => u.name).sort()
  assert.deepEqual(twice, ['Tree', 'Vinculi'])
})

test('a unit moved a row over is taken from its old spot when it shows at the new one', () => {
  const pieces = start()
  const hall = pieces.find(p => p.id === 2)
  // The old spot is half bare but the wide picture still half-matches there.
  const r = reading({ ground: ['3,1', '4,1'], verified: [{ key: hall.key, score: 0.6 }], sightings: [{ id: 2, x: 3, y: 3, score: 0.88 }] })
  const { roster, removed } = core.trackIsland(pieces, r, byId)
  assert.deepStrictEqual(ids(roster), ['1@0,0', '2@3,3'])
  assert.deepStrictEqual(ids(removed), ['2@3,1'])
  // Without bare tiles at the old spot it's a second copy, not a move.
  assert.deepStrictEqual(ids(core.trackIsland(pieces, { ...r, ground: [] }, byId).roster), ['1@0,0', '2@3,1', '2@3,3'])
})

test('a unit whose picture is plainly gone for three readings is taken off, even where the tile never looks bare', () => {
  let roster = start()
  const hut = roster.find(p => p.id === 1).key
  const gone = reading({ verified: [{ key: hut, score: 0 }] })
  // Never seen clearly (hidden behind something from the start): left alone.
  for (let i = 0; i < 4; i++) roster = core.trackIsland(roster, gone, byId).roster
  assert.strictEqual(roster.length, 2)
  roster = core.trackIsland(roster, reading({ verified: [{ key: hut, score: 0.8 }] }), byId).roster
  for (let i = 0; i < 2; i++) roster = core.trackIsland(roster, gone, byId).roster
  assert.strictEqual(roster.length, 2)
  // A good reading in between starts the count again.
  roster = core.trackIsland(roster, reading({ verified: [{ key: hut, score: 0.7 }] }), byId).roster
  for (let i = 0; i < 2; i++) roster = core.trackIsland(roster, gone, byId).roster
  assert.strictEqual(roster.length, 2)
  const last = core.trackIsland(roster, gone, byId)
  assert.deepStrictEqual(ids(last.removed), ['1@0,0'])
  // Island Stats open doesn't count.
  let r2 = core.trackIsland(start(), reading({ verified: [{ key: hut, score: 0.8 }] }), byId).roster
  for (let i = 0; i < 4; i++) r2 = core.trackIsland(r2, { ...gone, stats: true }, byId).roster
  assert.strictEqual(r2.length, 2)
})

test('a unit that shows up elsewhere while its old spot no longer matches has moved', () => {
  const pieces = start()
  const hut = pieces.find(p => p.id === 1)
  const { roster } = core.trackIsland(pieces, reading({ verified: [{ key: hut.key, score: 0 }], sightings: [{ id: 1, x: 6, y: 3, score: 0.88 }] }), byId)
  assert.deepStrictEqual(ids(roster), ['1@6,3', '2@3,1'])
})

test('a never-seen unit is taken off once the same kind shows up elsewhere, unless a purchase explains it', () => {
  // The old copy from the log, plus a copy at 6,3 seen later (kept from before the move rule).
  const pieces = [...start(), { key: '1@6,3', id: 1, x: 6, y: 3, how: 'seen', at: 5 }]
  const hut = pieces.find(p => p.id === 1 && p.how === 'log').key
  const gone = reading({ verified: [{ key: hut, score: 0 }, { key: '1@6,3', score: 0.85 }] })
  let roster = pieces
  for (let i = 0; i < 3; i++) roster = core.trackIsland(roster, gone, byId, 6).roster
  assert.deepStrictEqual(ids(roster), ['1@6,3', '2@3,1'])
  // Bought one this round: two of them is right, so the hidden one stays.
  let kept = pieces
  for (let i = 0; i < 4; i++) kept = core.trackIsland(kept, gone, byId, 6, { bought: [1] }).roster
  assert.strictEqual(kept.length, 3)
})

test('two of the same unit seen in one reading are both kept', () => {
  const { roster } = core.trackIsland([], reading({ sightings: [{ id: 3, x: 6, y: -6, score: 0.9 }, { id: 3, x: 6, y: 5, score: 0.9 }] }), byId)
  assert.deepStrictEqual(ids(roster), ['3@6,-6', '3@6,5'])
})

test('the log confirms units the screen already found, and replaces one misread at the same spot', () => {
  const roster = [
    { key: '1@0,0', id: 1, x: 0, y: 0, how: 'seen', at: 5, seen: true },
    { key: '3@3,1', id: 3, x: 3, y: 1, how: 'seen', at: 5, seen: true }, // a 1x2 where the log has the 2x2 Hall: another size, so the screen wins
    { key: '1@6,0', id: 1, x: 6, y: 0, how: 'seen', at: 5, inLog: true } // was on the last board, not this one
  ]
  const next = core.mergeLog(roster, build, byId, 9)
  assert.deepStrictEqual(ids(next), ['1@0,0', '1@6,0', '3@3,1'])
  assert.strictEqual(next.find(p => p.key === '1@0,0').inLog, true)
  assert.strictEqual(next.find(p => p.key === '1@6,0').inLog, false)
  // Same size, same spot, another name: the log's unit wins.
  const swapped = core.mergeLog([{ key: '3@0,1', id: 3, x: 0, y: 1, how: 'seen', at: 5 }], [{ id: 3, x: 0, y: 1, enchants: [] }, { id: 1, x: 5, y: 5, enchants: [] }], byId, 9)
  assert.deepStrictEqual(ids(swapped), ['1@5,5', '3@0,1'])
  const misread = core.mergeLog([{ key: '1@0,0', id: 1, x: 0, y: 0, how: 'seen', at: 5 }], [{ id: 4, x: 0, y: 0, enchants: [] }], core.indexUnits([...units, { id: 4, name: 'Shed', w: 1, h: 1 }]), 9)
  assert.deepStrictEqual(ids(misread), ['4@0,0'])
  // A weak small sighting standing wholly on a bigger board unit's tiles was a piece of that unit's picture.
  const inside = core.mergeLog([{ key: '1@4,0', id: 1, x: 4, y: 0, how: 'seen', at: 5, score: 0.66 }], build, byId, 9)
  assert.deepStrictEqual(ids(inside), ['1@0,0', '2@3,1'])
  const clear = core.mergeLog([{ key: '1@4,0', id: 1, x: 4, y: 0, how: 'seen', at: 5, score: 0.9 }], build, byId, 9)
  assert.deepStrictEqual(ids(clear), ['1@0,0', '1@4,0'])
  // A unit placed by hand isn't overruled.
  const manual = core.mergeLog([{ key: '1@0,0', id: 1, x: 0, y: 0, how: 'manual', at: 5 }], [{ id: 4, x: 0, y: 0, enchants: [] }], core.indexUnits([...units, { id: 4, name: 'Shed', w: 1, h: 1 }]), 9)
  assert.deepStrictEqual(ids(manual), ['1@0,0'])
})

test('the log moves a unit read a tile off its spot', () => {
  // The screen put the Hall a column right of where the board has it, and nothing else is listed there.
  const roster = [{ key: '1@0,0', id: 1, x: 0, y: 0, how: 'log', at: 0, inLog: true }, { key: '2@4,1', id: 2, x: 4, y: 1, how: 'seen', at: 1, score: 0.8 }]
  const merged = core.mergeLog(roster, build, byId, 9)
  assert.deepStrictEqual(ids(merged), ['1@0,0', '2@3,1'])
  assert.ok(merged.every(p => p.inLog))
  // Two tiles off is a different spot: left to the screen.
  const far = core.mergeLog([roster[0], { key: '2@5,1', id: 2, x: 5, y: 1, how: 'seen', at: 1, score: 0.8 }], build, byId, 9)
  assert.deepStrictEqual(ids(far), ['1@0,0', '2@3,1', '2@5,1'])
})

test('a unit the log confirmed gives way to a sighting like any other', () => {
  const pieces = start()
  const hut = pieces.find(p => p.id === 1)
  assert.strictEqual(hut.inLog, true)
  const sight = { id: 3, x: 0, y: 1, score: 0.9 }
  const kept = core.trackIsland(pieces, reading({ verified: [{ key: hut.key, score: 0.7 }], sightings: [sight] }), byId, 5)
  assert.deepStrictEqual(ids(kept.roster), ['1@0,0', '2@3,1'])
  // Moved or sold since that board: a clear sighting wins where the old unit matches poorly.
  const swapped = core.trackIsland(pieces, reading({ verified: [{ key: hut.key, score: 0.4 }], sightings: [sight] }), byId, 5)
  assert.deepStrictEqual(ids(swapped.roster), ['2@3,1', '3@0,1'])
  const unsure = core.trackIsland(pieces, reading({ verified: [{ key: hut.key, score: 0.3 }], sightings: [{ ...sight, score: 0.7 }] }), byId, 5)
  assert.deepStrictEqual(ids(unsure.roster), ['2@3,1', '3@0,1'])
})

test('a confirmed unit seen somewhere else, with another unit in its old spot, has moved', () => {
  const pieces = start()
  const hall = pieces.find(p => p.id === 2)
  const owned = new Map([[1, 1], [2, 1]])
  // The Hall turns up at 6,1 while something else stands on its old tiles (so they don't look bare).
  const r = reading({ verified: [{ key: hall.key, score: 0.45 }, { key: '1@0,0', score: 0.9 }], sightings: [{ id: 2, x: 6, y: 1, score: 0.85 }] })
  const moved = core.trackIsland(pieces, r, byId, 5, { owned })
  assert.deepStrictEqual(ids(moved.roster), ['1@0,0', '2@6,1'])
  // Without knowing how many there should be, two Halls it is.
  const both = core.trackIsland(pieces, r, byId, 5)
  assert.deepStrictEqual(ids(both.roster), ['1@0,0', '2@3,1', '2@6,1'])
  // A second Hall bought this round accounts for the new one.
  const bought = core.trackIsland(pieces, r, byId, 5, { owned: new Map([[1, 1], [2, 2]]) })
  assert.deepStrictEqual(ids(bought.roster), ['1@0,0', '2@3,1', '2@6,1'])
})

test('a unit\'s card names the unit at the spot under the mouse', () => {
  const pieces = start()
  // The Hall's spot holds a 1x2 misread as something else: the card's unit replaces it.
  const misread = [...pieces.filter(p => p.id === 1), { key: '3@3,1', id: 3, x: 3, y: 1, how: 'seen', at: 1 }]
  const { roster, removed } = core.nameFromCard(misread, { id: 2, x: 3, y: 1 }, byId, 5)
  assert.deepStrictEqual(ids(roster), ['1@0,0', '2@3,1'])
  assert.deepStrictEqual(ids(removed), ['3@3,1'])
  const named = roster.find(p => p.id === 2)
  assert.strictEqual(named.how, 'manual')
  assert.strictEqual(named.card, true)
  // Already there: only marked.
  const again = core.nameFromCard(pieces, { id: 1, x: 0, y: 0 }, byId, 5)
  assert.deepStrictEqual(ids(again.roster), ids(pieces))
  assert.strictEqual(again.roster.find(p => p.id === 1).card, true)
  // Moved: the copy at the old spot, seen there before and plainly gone now, is taken off.
  const old = pieces.map(p => p.id === 1 ? { ...p, seen: true } : p)
  const hut = old.find(p => p.id === 1)
  const moved = core.nameFromCard(old, { id: 1, x: 6, y: -6 }, byId, 5, { reading: reading({ verified: [{ key: hut.key, score: 0.1 }] }) })
  assert.deepStrictEqual(ids(moved.roster), ['1@6,-6', '2@3,1'])
  assert.deepStrictEqual(ids(moved.removed), [hut.key])
  // Still there (or never seen clearly): a second copy.
  const two = core.nameFromCard(old, { id: 1, x: 6, y: -6 }, byId, 5, { reading: reading({ verified: [{ key: hut.key, score: 0.8 }] }) })
  assert.deepStrictEqual(ids(two.roster), ['1@0,0', '1@6,-6', '2@3,1'])
  const hidden = core.nameFromCard(pieces.map(p => ({ ...p, seen: false })), { id: 1, x: 6, y: -6 }, byId, 5, { reading: reading({ verified: [{ key: hut.key, score: 0.1 }] }) })
  assert.strictEqual(hidden.roster.length, 3)
  // Hovered again where it already is: the old copy still goes.
  const twice = core.nameFromCard(two.roster, { id: 1, x: 6, y: -6 }, byId, 6, { reading: reading({ verified: [{ key: hut.key, score: 0.1 }] }) })
  assert.deepStrictEqual(ids(twice.roster), ['1@6,-6', '2@3,1'])
})

test('names read off a card match the unit list despite a misread letter', () => {
  const list = [{ id: 1, name: 'Bee Hive' }, { id: 2, name: 'Bee Keeper' }, { id: 3, name: 'Prismatic Mirror' }, { id: 4, name: 'Shrub' }]
  assert.strictEqual(core.matchName('Bee Hive\n', list).id, 1)
  assert.strictEqual(core.matchName('Prismatlc Mirror', list).id, 3)
  assert.strictEqual(core.matchName('Random Magic', list), null)
  assert.strictEqual(core.matchName('L¢ Random Madic ,', list), null)
  assert.strictEqual(core.matchName('', list), null)
})

test('a card\'s name still matches when the reading runs on past it', () => {
  const list = [{ id: 1, name: 'Soul Engine' }, { id: 2, name: 'Azurite' }, { id: 3, name: 'Tree' }, { id: 4, name: 'The Big Tree' }]
  assert.strictEqual(core.matchName('Soul Engi ne RUS RENN', list).id, 1)
  assert.strictEqual(core.matchName('Azurite |i', list).id, 2)
  assert.strictEqual(core.matchName('The Big Tree', list).id, 4)
  assert.strictEqual(core.matchName('Tree', list).id, 3)
})

test('unsure spots stay until named, covered or bare', () => {
  const byId = new Map([[1, { id: 1, w: 1, h: 1 }], [2, { id: 2, w: 2, h: 2 }]])
  const spot = { x: 0, y: 0, w: 1, h: 1, guesses: [{ id: 1, x: 0, y: 0, score: 0.63 }] }
  let spots = core.trackUnsure([], { view: 'ok', ground: [], unsure: [spot] }, [], byId, 1)
  assert.strictEqual(spots.length, 1)
  // A later read that doesn't search there again keeps it; a camera move changes nothing.
  spots = core.trackUnsure(spots, { view: 'ok', ground: ['3,3'] }, [], byId, 2)
  spots = core.trackUnsure(spots, { view: 'moved' }, [], byId, 3)
  assert.strictEqual(spots.length, 1)
  // A unit put over it settles it.
  assert.strictEqual(core.trackUnsure(spots, null, [{ key: '2@-1,0', id: 2, x: -1, y: 0 }], byId, 4).length, 0)
  // Its tile turning bare clears it.
  assert.strictEqual(core.trackUnsure(spots, { view: 'ok', ground: ['0,0'] }, [], byId, 4).length, 0)
  // A new spot over the same tiles replaces it.
  const moved = { ...spot, guesses: [{ id: 1, x: 0, y: 0, score: 0.66 }] }
  const next = core.trackUnsure(spots, { view: 'ok', ground: [], unsure: [moved] }, [], byId, 5)
  assert.deepStrictEqual(next.map(s => s.guesses[0].score), [0.66])
})
