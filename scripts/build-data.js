// Rebuilds data/*.json from a SkyShard-Public checkout.
// Usage: node scripts/build-data.js <path to SkyShard-Public/game_info>
const fs = require('fs')
const path = require('path')
const core = require('../src/core')

const src = process.argv[2]
if (!src) {
  console.error('Usage: node scripts/build-data.js <path to SkyShard-Public/game_info>')
  process.exit(1)
}
const read = name => JSON.parse(fs.readFileSync(path.join(src, name), 'utf8'))
const out = path.join(__dirname, '..', 'data', 'game-data.json')

const data = {
  patch: read('Main.json').Patch,
  units: core.flattenUnits(read('unit_data.JSON')),
  shops: core.flattenShops(read('encounter_data.JSON'))
}
fs.writeFileSync(out, JSON.stringify(data))
console.log(`Wrote ${data.units.length} units and ${data.shops.length} shops for patch ${data.patch} to ${out}`)
