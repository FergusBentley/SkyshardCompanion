const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const core = require('../src/core')

const data = require('../data/game-data.json')
const byId = core.indexUnits(data.units)
const log = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.log'), 'utf8')
const decode = code => core.boardFromWords(core.wordsFromBytes(zlib.gunzipSync(Buffer.from(code, 'base64url'))))
const idOf = name => data.units.find(u => u.name === name).id

test('parseLog finds the last build, its opponent and the round', () => {
  const parsed = core.parseLog(log)
  assert.match(parsed.build, /^H4sI/)
  assert.match(parsed.opponent, /^H4sI/)
  assert.strictEqual(parsed.builds, 16)
  assert.strictEqual(parsed.round, 16)
  assert.strictEqual(parsed.mode, 'Ranked T4')
})

test('build codes decode to known units on the island', () => {
  const parsed = core.parseLog(log)
  const board = decode(parsed.build)
  assert.ok(board.length > 50)
  for (const p of board) {
    const u = byId.get(p.id)
    assert.ok(u, `unknown unit id ${p.id}`)
    const col = p.x + core.ISLAND_OFFSET
    const top = p.y - u.h + 1 + core.ISLAND_OFFSET
    assert.ok(col >= 0 && col + u.w <= core.ISLAND_COLS, `${u.name} x out of range`)
    assert.ok(top >= 0 && top + u.h <= core.ISLAND_ROWS.length, `${u.name} y out of range`)
  }
  assert.ok(decode(parsed.opponent).some(p => byId.get(p.id).name === 'Toy Store'))
})

test('first round board is small', () => {
  const first = log.match(/^Current build: (\S+)/m)[1]
  assert.ok(decode(first).length < 10)
})

test('recommend counts synergy in both directions and explains it', () => {
  const owned = core.ownedCounts([idOf('Town Hall')])
  const recs = core.recommend(owned, data.units, byId)
  const jeffrey = recs.find(r => r.unit.name === 'Jeffrey')
  assert.ok(jeffrey, 'Jeffrey lists Town Hall and vice versa')
  assert.strictEqual(jeffrey.score, 2)
  assert.deepStrictEqual(jeffrey.reasons.map(r => r.name), ['Town Hall'])
  assert.ok(recs.every(r => r.unit.inShop))
})

test('conditional units only unlock once their requirement is owned', () => {
  const toyProduction = data.units.find(u => u.name === 'Toy Production')
  assert.ok(!core.unlocks(new Map(), data.units).includes(toyProduction))
  assert.ok(core.unlocks(core.ownedCounts([idOf('Toy Store')]), data.units).includes(toyProduction))
})

test('shop pools respect filters, tiers and top-tier weighting', () => {
  const shop = data.shops.find(s => s.name === 'Weapons' && s.cost === 4)
  const pool = core.shopPool(shop, data.units, new Map())
  assert.ok(pool.length > 0)
  for (const { unit, weight } of pool) {
    assert.strictEqual(core.ROLES[unit.role], 'Weapon')
    assert.ok([3, 4].includes(unit.rarity))
    assert.strictEqual(weight, unit.rarity === 4 ? 2 : 1)
  }
})

test('scoreShops ranks shops with fitting units first', () => {
  const board = decode(core.parseLog(log).build)
  const owned = core.ownedCounts(board.map(p => p.id))
  const recs = core.recommend(owned, data.units, byId)
  const scored = core.scoreShops(data.shops, data.units, owned, recs)
  assert.ok(scored.length > 20)
  assert.ok(scored[0].chance >= scored[scored.length - 1].chance)
  assert.ok(scored[0].fits.length > 0)
  for (const s of scored) assert.ok(s.chance >= 0 && s.chance <= 1)
})

test('topPicks keeps ties with the last place', () => {
  const recs = [5, 4, 4, 4, 2].map(score => ({ score }))
  assert.strictEqual(core.topPicks(recs, 2).length, 4)
  assert.strictEqual(core.topPicks([], 2).length, 0)
})

test('shop chances on a late-game board are not all 100%', () => {
  const board = decode(core.parseLog(log).build)
  const owned = core.ownedCounts(board.map(p => p.id))
  const scored = core.scoreShops(data.shops, data.units, owned, core.recommend(owned, data.units, byId))
  assert.ok(scored.some(s => s.chance < 1) && scored.some(s => s.chance === 0))
})

test('parseLog keys each run by its first build, so a finished run can be set aside', () => {
  const run = (a, b) => `Current build: ${a}\n[1m] Server Action: GET DIR 1_Ranked_T4 | ok\nCurrent build: ${b}\n[2m] Server Action: GET DIR 2_Ranked_T4 | ok\n`
  assert.strictEqual(core.parseLog(run('A1', 'A2')).runKey, 'A1')
  assert.strictEqual(core.parseLog(run('A1', 'A2') + run('B1', 'B2')).runKey, 'B1')
  // A build whose round isn't written yet still counts with the run before it.
  assert.strictEqual(core.parseLog(run('A1', 'A2') + 'Current build: B1\n').runKey, 'A1')
})
