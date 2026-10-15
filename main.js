const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen, session, nativeImage, shell } = require('electron/main')
const { Worker } = require('worker_threads')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const core = require('./src/core')
const sight = require('./src/vision')

const DATA_BASE = 'https://raw.githubusercontent.com/ItsBen321/SkyShard-Public/main/game_info/'
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const dataCacheFile = () => path.join(app.getPath('userData'), 'game-data.json')
const defaultLogPath = () => path.join(app.getPath('appData'), 'Project SkyShard', 'logs', 'godot.log')

let win = null
let settings = {}
let gameData = null
let logState = { status: 'waiting' }
let pollTimer = null
let lastCodes = ''
let vision = { status: 'off' }
let visionWorker = null
// The island is read on a second worker, so a shop never waits behind an island reading.
let islandWorker = null
let visionTimer = null
let cursorTimer = null
let captureWin = null
let captureSource = null
let streaming = false
let shopSeq = 0
let shopSession = null
const sessions = new Map()
const cursorTrail = []
const ART_DIR = path.join(__dirname, 'unit-art')
const CURSOR_MS = 20
const MAX_CAPTURES = 60

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload) }
const logPath = () => settings.logPath || defaultLogPath()

function saveSettings () {
  fs.writeFileSync(settingsFile(), JSON.stringify(settings))
}

function decodeBoard (code) {
  try {
    const bytes = zlib.gunzipSync(Buffer.from(code, 'base64url'))
    return core.boardFromWords(core.wordsFromBytes(bytes))
  } catch (err) {
    console.error('Could not decode build code:', err.message)
    return null
  }
}

function readLog () {
  const file = logPath()
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    lastCodes = ''
    logState = { status: 'missing', path: file }
    send('log', logState)
    return
  }
  const parsed = core.parseLog(text)
  const codes = `${parsed.build}|${parsed.opponent}`
  if (codes === lastCodes) return
  const newBuild = !lastCodes.startsWith(`${parsed.build}|`)
  lastCodes = codes
  if (!parsed.build) {
    // A new game session rotates the log. Keep showing the last board we had.
    logState = logState.build
      ? { ...logState, status: 'stale', path: file, newBuild: false }
      : { status: 'no-build', path: file }
  } else {
    logState = {
      status: 'ok',
      path: file,
      build: decodeBoard(parsed.build),
      opponent: parsed.opponent ? decodeBoard(parsed.opponent) : null,
      round: parsed.round,
      mode: parsed.mode,
      runKey: parsed.runKey,
      newBuild,
      updatedAt: newBuild ? Date.now() : logState.updatedAt
    }
  }
  send('log', logState)
}

// Re-read the log every second instead of watching it. Windows doesn't always update a
// file's size or modified time while the game still has it open, so fs.watchFile misses writes.
function watchLog () {
  clearInterval(pollTimer)
  lastCodes = ''
  readLog()
  pollTimer = setInterval(readLog, 1000)
}

function loadBundledData () {
  const bundled = readJson(path.join(__dirname, 'data', 'game-data.json'))
  const cached = readJson(dataCacheFile())
  // A cached download only exists when the repo had a different patch than the bundle.
  gameData = cached && cached.patch !== bundled.patch ? { ...cached, source: 'download' } : { ...bundled, source: 'bundled' }
}

async function refreshData () {
  try {
    const get = async name => {
      const res = await fetch(DATA_BASE + name, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
      return res.json()
    }
    const { Patch: patch } = await get('Main.json')
    if (patch === gameData.patch) return
    const [units, shops] = await Promise.all([get('unit_data.JSON'), get('encounter_data.JSON')])
    const fresh = { patch, units: core.flattenUnits(units), shops: core.flattenShops(shops) }
    fs.writeFileSync(dataCacheFile(), JSON.stringify(fresh))
    gameData = { ...fresh, source: 'download' }
    send('data', gameData)
  } catch (err) {
    console.warn('Keeping current game data:', err.message)
  }
}

/* ---------- Shop reading from the screen ---------- */
// A hidden window watches a live video of the game. When the shop island appears it sends that
// first frame here, and the worker reads the units. Picking a unit closes the shop at once, so the
// pick is worked out from where the mouse was when the shop closed.

function setVision (next) {
  if (next.status === vision.status && next.window === vision.window) return
  vision = next
  send('vision', vision)
}

function stopVision (status = 'off') {
  clearInterval(visionTimer)
  clearInterval(cursorTimer)
  visionTimer = cursorTimer = null
  if (visionWorker) visionWorker.terminate()
  if (islandWorker) islandWorker.terminate()
  islandBusy = false
  visionWorker = islandWorker = null
  if (captureWin && !captureWin.isDestroyed()) captureWin.destroy()
  captureWin = null
  streaming = false
  shopSession = null
  setVision({ status })
}

function startVision () {
  stopVision()
  if (settings.readShops === false) return
  if (!fs.existsSync(path.join(ART_DIR, 'templates.bin'))) return setVision({ status: 'no-art' })
  const units = gameData.units.map(u => ({ id: u.id, w: u.w, h: u.h, inShop: u.inShop }))
  visionWorker = new Worker(path.join(__dirname, 'src', 'vision-worker.js'), { workerData: { dir: ART_DIR, units, empty: emptyShop() } })
  islandWorker = new Worker(path.join(__dirname, 'src', 'vision-worker.js'), { workerData: { dir: ART_DIR, units, empty: null } })
  for (const w of [visionWorker, islandWorker]) {
    w.on('message', onShopRead)
    w.on('error', err => {
      console.error('Shop reader stopped:', err)
      stopVision('error')
    })
  }

  const ses = session.fromPartition('capture')
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(captureSource ? { video: captureSource } : {}))
  captureWin = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-capture.js'), session: ses, backgroundThrottling: false }
  })
  captureWin.loadFile('capture.html')
  captureWin.webContents.on('did-finish-load', findGame)
  setVision({ status: 'looking' })
  visionTimer = setInterval(() => { if (!streaming) findGame() }, 3000)
  cursorTimer = setInterval(trackCursor, CURSOR_MS)
}

// The shop island with nothing on it, which tells the capture page when units are standing on it.
let emptyShopCache = null
function emptyShop () {
  if (!emptyShopCache) {
    const meta = readJson(path.join(ART_DIR, 'empty-shop.json'))
    const data = zlib.gunzipSync(fs.readFileSync(path.join(ART_DIR, 'empty-shop.bgra.gz')))
    emptyShopCache = { ...meta, data: new Uint8Array(data) }
  }
  return emptyShopCache
}

// Other apps whose window titles can mention the game, like a Discord server called Project SkyShard.
const NOT_GAME = /discord|chrome|firefox|edge|opera|brave|vivaldi|steam|obs|youtube|twitch|reddit|companion|explorer|notepad|visual studio/i

// The game's own window: its title is just the game's name; anything else that mentions it comes second.
function pickGameWindow (sources) {
  const windows = sources.filter(s => s.id.startsWith('window:') && /sky\s*shard/i.test(s.name) && !NOT_GAME.test(s.name))
  return windows.find(s => /^\s*(project\s*)?sky\s*shard\s*$/i.test(s.name)) || windows[0] || null
}

// The game's window if it has one we can see.
async function findGame () {
  if (!captureWin || streaming) return
  try {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    const own = win && !win.isDestroyed() ? win.getMediaSourceId() : ''
    const game = pickGameWindow(sources.filter(s => s.id !== own))
    if (!game) return setVision({ status: 'looking' })
    captureSource = game
    captureWin.webContents.send('capture-start', emptyShop())
  } catch (err) {
    console.error('Looking for the game failed:', err.message)
  }
}

ipcMain.on('capture-started', () => {
  streaming = true
  setVision({ status: 'watching', window: captureSource && captureSource.name })
})

ipcMain.on('capture-ended', (_event, reason) => {
  streaming = false
  if (reason) console.warn('Game capture stopped:', reason)
  setVision({ status: 'looking' })
})

// Mouse positions from the last few seconds, in screen coordinates.
function trackCursor () {
  const p = screen.getCursorScreenPoint()
  const t = Date.now()
  cursorTrail.push({ t, x: p.x, y: p.y })
  while (cursorTrail.length && cursorTrail[0].t < t - 5000) cursorTrail.shift()
}

// The screen the mouse spent most of the shop on, which is the one the game is on.
function gameDisplay (points, fallback) {
  const counts = new Map()
  for (const p of points) {
    const d = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) })
    const c = counts.get(d.id) || { d, n: 0 }
    c.n++
    counts.set(d.id, c)
  }
  let best = null
  for (const c of counts.values()) if (!best || c.n > best.n) best = c
  return best ? best.d : fallback
}

// Screen coordinates to game frame coordinates, assuming the game fills the screen it is on.
function toFrame (points, display) {
  const b = display.bounds
  return points.map(p => ({ t: p.t, x: (p.x - b.x) * 1280 / b.width, y: (p.y - b.y) * 720 / b.height }))
}

ipcMain.on('shop-opened', (_event, frame) => {
  if (!visionWorker) return
  const id = ++shopSeq
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  shopSession = { id, size: frame.size, openedAt: frame.t, display, shop: null, closed: null }
  sessions.set(id, shopSession)
  const data = Buffer.from(frame.data.buffer || frame.data, frame.data.byteOffset || 0, frame.data.byteLength)
  saveCapture(id, frame.width, frame.height, data)
  visionWorker.postMessage({ type: 'read', id, size: frame.size, width: frame.width, height: frame.height, data: new Uint8Array(data).buffer })
  send('shop', { type: 'opening', id })
})

ipcMain.on('shop-closed', (_event, info) => {
  const s = shopSession
  if (!s) return
  shopSession = null
  s.closed = { ...info, trail: cursorTrail.filter(p => p.t >= info.lastOpenAt - 1000 && p.t <= info.closedAt + 50) }
  resolvePick(s)
})

// The island, read from the game while you plan (with or without the grid showing).
let islandBusy = false
let islandSeq = 0
let islandFrame = null // the frame being read, kept until its reading shows whether it's worth saving
// Enough for a whole run, so unit variants can be learned from it afterwards against the game log.
const MAX_ISLAND_SHOTS = 150
let islandSavedAt = 0
let islandHints = []
let islandMissing = []
let islandPieces = []
ipcMain.on('island-look-for', (_event, look) => {
  islandHints = Array.isArray(look && look.hints) ? look.hints.filter(Number.isInteger).slice(0, 20) : []
  islandMissing = Array.isArray(look && look.missing) ? look.missing.filter(Number.isInteger).slice(0, 8) : []
  islandPieces = Array.isArray(look && look.pieces) ? look.pieces.slice(0, 200) : []
})
// A new run: the island is read from scratch.
ipcMain.on('island-new-run', () => { if (islandWorker) islandWorker.postMessage({ type: 'island-reset' }) })
// The round on the game's counter, which tells the window when a new run has started.
ipcMain.on('screen-round', (_event, n) => { if (Number.isInteger(n)) send('screen-round', n) })

ipcMain.on('island-seen', (_event, frame) => {
  if (!islandWorker || islandBusy) return
  islandBusy = true
  const bytes = d => Buffer.from(d.buffer || d, d.byteOffset || 0, d.byteLength)
  const data = bytes(frame.data)
  // The island at full size, when the game runs above 1280x720 (sharper look at small units).
  const h = frame.hi
  const hi = h && Number.isFinite(h.scale) && h.width > 0 && h.height > 0 && h.data && h.data.byteLength === h.width * h.height * 4
    ? { scale: h.scale, x0: h.x0, y0: h.y0, width: h.width, height: h.height, data: Buffer.from(bytes(h.data)) }
    : null
  islandFrame = { width: frame.width, height: frame.height, data: Buffer.from(data), hi }
  islandWorker.postMessage({
    type: 'island', id: ++islandSeq, hints: islandHints, missing: islandMissing, pieces: islandPieces, width: frame.width, height: frame.height, data: new Uint8Array(data).buffer,
    hi: hi && { ...hi, data: new Uint8Array(hi.data).buffer }
  })
})

// A unit's card was up in the game. Its title is read as text and matched to a unit's name; the island
// worker then finds where that unit stands near the mouse. Needs tesseract.js (npm install); without
// it, cards are just ignored.
let cardText = null
function cardReader () {
  if (cardText === null) {
    cardText = (async () => {
      const Tesseract = require('tesseract.js')
      // Inside Electron, tesseract.js treats langPath as a web address, so the English data is handed
      // over as its "cache" instead: a copy in the app's folder, read straight from disk.
      const cachePath = path.join(app.getPath('userData'), 'ocr')
      const cached = path.join(cachePath, 'eng.traineddata')
      if (!fs.existsSync(cached)) {
        fs.mkdirSync(cachePath, { recursive: true })
        fs.copyFileSync(path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0', 'eng.traineddata.gz'), cached)
      }
      const worker = await Tesseract.createWorker('eng', 1, {
        cachePath,
        cacheMethod: 'readOnly',
        errorHandler: err => console.warn('Card reader error:', err && err.message ? err.message : err)
      })
      await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '-" }) // one line of letters
      return worker
    })().catch(err => { console.warn('Unit cards won\'t be read:', err.message); return false })
  }
  return cardText
}

let cardBusy = false
let cardFrame = null
ipcMain.on('unit-card', async (_event, msg) => {
  if (!islandWorker || cardBusy || !gameData) return
  // Where the mouse was when the card was seen: it rests on the unit, so it's on a shop slot or the island.
  const near = cursorTrail.length ? cursorTrail.reduce((a, b) => Math.abs(b.t - msg.t) < Math.abs(a.t - msg.t) ? b : a) : { t: msg.t, ...screen.getCursorScreenPoint() }
  const [cursor] = toFrame([near], screen.getDisplayNearestPoint({ x: Math.round(near.x), y: Math.round(near.y) }))
  const shop = shopSession
  const slots = shop && (shop.shop ? shop.shop.slots : sight.LAYOUTS[shop.size])
  const slot = slots ? sight.slotAt({ slots }, cursor) : -1
  if (slot < 0 && !sight.tileAt(cursor.x, cursor.y)) return noteCard({ t: msg.t, box: msg.box, cursor, skipped: 'mouse not on a shop slot or an island tile' })
  cardBusy = true
  try {
    const reader = await cardReader()
    if (!reader) return noteCard({ t: msg.t, box: msg.box, cursor, skipped: 'text reader missing: run npm install' })
    const { width, height, data } = msg.title
    const gray = Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength)
    const bgra = Buffer.alloc(width * height * 4, 255)
    for (let i = 0; i < gray.length; i++) bgra[i * 4] = bgra[i * 4 + 1] = bgra[i * 4 + 2] = gray[i]
    const text = (await reader.recognize(nativeImage.createFromBitmap(bgra, { width, height }).toPNG())).data.text.trim()
    const unit = core.matchName(text, gameData.units)
    noteCard({ t: msg.t, box: msg.box, cursor, text, unit: unit ? unit.id : null, slot: slot >= 0 ? slot : undefined })
    if (!unit) return
    // A shop unit's card says what's in that slot.
    if (slot >= 0) return send('shop', { type: 'card', id: shop.id, slot, unit: unit.id })
    const bytes = d => Buffer.from(d.buffer || d, d.byteOffset || 0, d.byteLength)
    const frame = bytes(msg.data)
    const h = msg.hi
    const hi = h && Number.isFinite(h.scale) && h.data && h.data.byteLength === h.width * h.height * 4
      ? { scale: h.scale, x0: h.x0, y0: h.y0, width: h.width, height: h.height, data: new Uint8Array(bytes(h.data)).buffer }
      : null
    cardFrame = { width: msg.width, height: msg.height, data: Buffer.from(frame), name: unit.name }
    islandWorker.postMessage({ type: 'card', id: ++islandSeq, unit: unit.id, name: unit.name, others: islandPieces.filter(p => p.id === unit.id), box: msg.box, cursor, width: msg.width, height: msg.height, data: new Uint8Array(frame).buffer, hi })
  } catch (err) {
    console.warn('Could not read a unit card:', err.message)
  } finally {
    cardBusy = false
  }
})

// What each card said and where its unit was found, in cards.log, with the last few card pictures.
function noteCard (info) {
  try {
    fs.mkdirSync(captureDir(), { recursive: true })
    const file = path.join(captureDir(), 'cards.log')
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-499) : []
    lines.push(JSON.stringify({ ...info, time: new Date(info.t || Date.now()).toISOString() }))
    fs.writeFileSync(file, lines.join('\n') + '\n')
  } catch (err) {
    console.warn('Could not write the card log:', err.message)
  }
}
function saveCardPicture (frame) {
  try {
    const dir = path.join(captureDir(), 'cards')
    fs.mkdirSync(dir, { recursive: true })
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${frame.name.replace(/[^a-z0-9]+/gi, '_')}`
    fs.writeFileSync(path.join(dir, `${name}.png`), nativeImage.createFromBitmap(frame.data, { width: frame.width, height: frame.height }).toPNG())
    for (const f of fs.readdirSync(dir).sort().slice(0, -40)) fs.rmSync(path.join(dir, f), { force: true })
  } catch (err) {
    console.warn('Could not save card picture:', err.message)
  }
}

// Keeps the last few island pictures where something was seen, with what was read, to check against.
function saveIsland (frame, reading) {
  try {
    const dir = path.join(captureDir(), 'island')
    fs.mkdirSync(dir, { recursive: true })
    const name = new Date().toISOString().replace(/[:.]/g, '-')
    fs.writeFileSync(path.join(dir, `${name}.png`), nativeImage.createFromBitmap(frame.data, { width: frame.width, height: frame.height }).toPNG())
    const hi = frame.hi && { scale: frame.hi.scale, x0: frame.hi.x0, y0: frame.hi.y0, width: frame.hi.width, height: frame.hi.height }
    if (hi) fs.writeFileSync(path.join(dir, `${name}.full.png`), nativeImage.createFromBitmap(frame.hi.data, { width: hi.width, height: hi.height }).toPNG())
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ reading, pieces: islandPieces, hints: islandHints, missing: islandMissing, hi }))
    const old = fs.readdirSync(dir).filter(f => f.endsWith('.png') && !f.endsWith('.full.png')).sort().slice(0, -MAX_ISLAND_SHOTS)
    for (const f of old) for (const ext of ['.png', '.full.png', '.json']) fs.rmSync(path.join(dir, f.replace(/\.png$/, ext)), { force: true })
  } catch (err) {
    console.warn('Could not save island picture:', err.message)
  }
}

function onShopRead (msg) {
  if (msg.type === 'card' || msg.type === 'card-error') {
    if (cardFrame) saveCardPicture(cardFrame)
    cardFrame = null
    if (msg.type === 'card-error') return console.error('Finding a card\'s unit failed:', msg.message)
    // The spot the unit's picture matches best near the mouse, when it's clearly the best one.
    const [best, next] = msg.spots
    // (Some small units, like the Ruby, never match well; a fair match far ahead of the rest will do.
    // Only spots where the picture would cover the mouse are tried, so a lone weak match is the one.)
    const lead = best && next ? best.score - next.score : 1
    const sure = best && ((best.score >= 0.5 && lead >= 0.1) || (best.score >= 0.4 && lead >= 0.15) || (best.score >= 0.3 && lead >= 0.25))
    noteCard({ t: Date.now(), unit: msg.unit, spots: msg.spots, others: msg.others, placed: !!sure })
    if (sure) send('unit-card', { id: msg.unit, x: best.x, y: best.y, score: best.score, others: msg.others || [] })
    return
  }
  if (msg.type === 'island' || msg.type === 'island-error') {
    islandBusy = false
    if (msg.type === 'island-error') { islandFrame = null; return console.error('Island reading failed:', msg.message) }
    const reading = msg.reading
    const due = Date.now() - islandSavedAt > 60000 // at least one plain picture a minute, too
    if (reading && islandFrame && reading.view === 'ok' && (reading.grid || reading.sightings.length || due)) {
      islandSavedAt = Date.now()
      saveIsland(islandFrame, reading)
    }
    islandFrame = null
    // Something new was seen once: ask for another look straight away to confirm it.
    if (reading && reading.pending && captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('island-recheck')
    if (reading) send('island', { ...reading, at: Date.now() })
    return
  }
  const s = sessions.get(msg.id)
  if (!s) return
  if (msg.type === 'error') {
    console.error('Shop reading failed:', msg.message)
    sessions.delete(msg.id)
    return send('shop', { type: 'failed', id: msg.id })
  }
  s.shop = msg.shop
  send('shop', { type: 'shop', id: s.id, size: s.shop.size, slots: s.shop.slots })
  saveLabels(s.id, { read: s.shop })
  resolvePick(s)
}

function resolvePick (s) {
  if (!s.shop || !s.closed) return
  sessions.delete(s.id)
  const trail = toFrame(s.closed.trail, gameDisplay(s.closed.trail, s.display))
  // The mouse is the best clue; failing that, the first unit to leave the shop.
  let slot = sight.pickFromTrail(s.shop, trail, s.closed.lastOpenAt, s.closed.closedAt)
  if (slot < 0) slot = s.closed.firstGone
  saveLabels(s.id, { trail, lastOpenAt: s.closed.lastOpenAt, closedAt: s.closed.closedAt, firstGone: s.closed.firstGone, pickedSlot: slot })
  send('shop', { type: 'pick', id: s.id, slot })
}

// Keeps the latest shop pictures so recognition can be checked against real games.
const captureDir = () => path.join(app.getPath('userData'), 'shop-captures')
const captureNames = new Map()

function saveCapture (id, width, height, bgra) {
  try {
    fs.mkdirSync(captureDir(), { recursive: true })
    const name = new Date().toISOString().replace(/[:.]/g, '-')
    captureNames.set(id, name)
    fs.writeFileSync(path.join(captureDir(), `${name}.png`), nativeImage.createFromBitmap(bgra, { width, height }).toPNG())
    const old = fs.readdirSync(captureDir()).filter(f => /^\d.*\.png$/.test(f)).sort().slice(0, -MAX_CAPTURES)
    for (const f of old) {
      fs.rmSync(path.join(captureDir(), f), { force: true })
      fs.rmSync(path.join(captureDir(), f.replace(/\.png$/, '.json')), { force: true })
    }
  } catch (err) {
    console.warn('Could not save shop picture:', err.message)
  }
}

function saveLabels (id, extra) {
  const name = captureNames.get(id)
  if (!name) return
  const file = path.join(captureDir(), `${name}.json`)
  try {
    fs.writeFileSync(file, JSON.stringify({ ...(readJson(file) || {}), ...extra }, null, 1))
  } catch (err) {
    console.warn('Could not save shop notes:', err.message)
  }
}

// What the player says was in the shop and which unit they took.
// What the capture page saw, once a second; kept short.
ipcMain.on('capture-debug', (_event, info) => {
  try {
    fs.mkdirSync(captureDir(), { recursive: true })
    if (info.frame) {
      const { width, height, data } = info.frame
      const png = nativeImage.createFromBitmap(Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength), { width, height }).toPNG()
      if (info.unsure) {
        // The shop island showed but no shop was seen on it: keep the last few of these.
        fs.writeFileSync(path.join(captureDir(), `unsure-${new Date(info.t).toISOString().replace(/[:.]/g, '-')}.png`), png)
        for (const f of fs.readdirSync(captureDir()).filter(f => f.startsWith('unsure-')).sort().slice(0, -10)) fs.rmSync(path.join(captureDir(), f), { force: true })
      } else fs.writeFileSync(path.join(captureDir(), 'last-frame.png'), png)
      delete info.frame
    }
    const file = path.join(captureDir(), 'vision-debug.log')
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-1799) : []
    lines.push(JSON.stringify({ ...info, time: new Date(info.t).toISOString() }))
    fs.writeFileSync(file, lines.join('\n') + '\n')
  } catch (err) {
    console.warn('Could not write the shop reader log:', err.message)
  }
})

ipcMain.on('shop-label', (_event, { id, units, picked }) => saveLabels(id, { player: { units, picked } }))
ipcMain.handle('open-captures', () => {
  fs.mkdirSync(captureDir(), { recursive: true })
  return shell.openPath(captureDir())
})

ipcMain.handle('get-state', () => ({ data: gameData, log: logState, logPath: logPath(), customLog: !!settings.logPath, vision }))

ipcMain.handle('set-read-shops', (_event, on) => {
  settings.readShops = !!on
  saveSettings()
  startVision()
  return vision
})

ipcMain.handle('choose-log', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose godot.log',
    defaultPath: logPath(),
    properties: ['openFile'],
    filters: [{ name: 'Log files', extensions: ['log', 'txt'] }, { name: 'All files', extensions: ['*'] }]
  })
  if (!result.canceled && result.filePaths[0]) {
    settings.logPath = result.filePaths[0]
    saveSettings()
    watchLog()
  }
  return { logPath: logPath(), customLog: !!settings.logPath }
})

ipcMain.handle('reset-log', () => {
  delete settings.logPath
  saveSettings()
  watchLog()
  return { logPath: logPath(), customLog: false }
})

const createWindow = () => {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    title: 'Skyshard Companion',
    backgroundColor: '#12161f',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.removeMenu()
  // The hidden capture window would otherwise keep the app running.
  win.on('closed', () => { stopVision(); if (process.platform !== 'darwin') app.quit() })
  win.loadFile('index.html')
  // Re-send the latest board once the page is ready.
  win.webContents.on('did-finish-load', () => { send('log', logState); send('vision', vision) })
}

app.whenReady().then(() => {
  settings = readJson(settingsFile()) || {}
  loadBundledData()
  createWindow()
  watchLog()
  refreshData()
  startVision()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
