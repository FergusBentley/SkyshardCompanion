// Reads shops and the island grid off the main thread.
const { parentPort, workerData } = require('worker_threads')
const fs = require('fs')
const path = require('path')
const vision = require('./vision')
const IslandWatch = require('./island-watch')

const index = JSON.parse(fs.readFileSync(path.join(workerData.dir, 'index.json'), 'utf8'))
const bytes = fs.readFileSync(path.join(workerData.dir, 'templates.bin'))
const templates = vision.loadTemplates({ index: index.templates, bytes }, workerData.units)
// The shop island with nothing on it, to tell how big each unit is.
const empty = workerData.empty || null
const units = new Map(workerData.units.map(u => [u.id, u]))

// The island, read on every frame the capture page sends (with or without the grid showing).
const watcher = IslandWatch.createWatcher(templates, units)
// The last couple of usable island frames, to find a unit a card names (the card's frame tints it).
let lastViews = []
function readIsland (msg) {
  const frame = { width: msg.width, height: msg.height, data: new Uint8Array(msg.data) }
  const hi = msg.hi ? { ...msg.hi, data: new Uint8Array(msg.hi.data) } : null
  const reading = watcher.read(frame, { pieces: msg.pieces || [], hints: msg.hints || [], missing: msg.missing || [], hi })
  if (reading.view === 'ok') lastViews = [{ frame, hi }, ...lastViews].slice(0, 2)
  const round = list => (list || []).map(f => ({ ...f, score: Math.round(f.score * 1000) / 1000 }))
  parentPort.postMessage({ type: 'island', id: msg.id, reading: { ...reading, verified: round(reading.verified), sightings: round(reading.sightings) } })
}

// A unit's card was up: where the unit it names stands, near the mouse.
function locateCard (msg) {
  const frame = { width: msg.width, height: msg.height, data: new Uint8Array(msg.data) }
  const hi = msg.hi ? { ...msg.hi, data: new Uint8Array(msg.hi.data) } : null
  const spots = vision.locateCardUnit(frame, templates, units, msg.unit, msg.box, msg.cursor, hi, lastViews).slice(0, 3)
  // The other copies of that unit the app knows about, checked on the last island frames before the card
  // (the card's own frame covers and tints things): one that's plainly gone was moved to the hovered spot.
  const others = lastViews.length ? (msg.others || []).map(p => ({
    key: p.key, score: Math.round(Math.max(...lastViews.map(v => vision.verifyOnIsland(v.frame, templates, units, [p], v.hi)[0].score)) * 1000) / 1000
  })) : []
  parentPort.postMessage({ type: 'card', id: msg.id, unit: msg.unit, name: msg.name, spots: spots.map(s => ({ ...s, score: Math.round(s.score * 1000) / 1000 })), others })
}

parentPort.on('message', msg => {
  if (msg.type === 'island-reset') { lastViews = []; return watcher.reset() }
  if (msg.type === 'card') {
    try { locateCard(msg) } catch (err) { parentPort.postMessage({ type: 'card-error', id: msg.id, message: err.message }) }
    return
  }
  if (msg.type === 'island') {
    try { readIsland(msg) } catch (err) { parentPort.postMessage({ type: 'island-error', id: msg.id, message: err.message }) }
    return
  }
  if (msg.type !== 'read') return
  try {
    const shop = vision.readShop(vision.pyramid({ width: msg.width, height: msg.height, data: new Uint8Array(msg.data) }), templates, msg.size, empty)
    const slots = shop.slots.map(s => ({ x: s.x, y: s.y, sure: s.sure, options: s.options.map(o => ({ id: o.id, score: Math.round(o.score * 1000) / 1000 })) }))
    parentPort.postMessage({ type: 'shop', id: msg.id, shop: { size: shop.size, slots } })
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: err.message })
  }
})
parentPort.postMessage({ type: 'ready', templates: templates.size })
