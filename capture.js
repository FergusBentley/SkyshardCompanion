/* global SkyVision */
// Hidden page that watches a live video of the game and tells the main process when a shop opens and closes.
const api = window.capture
const W = SkyVision.FRAME_W
const H = SkyVision.FRAME_H
const TICK_MS = 100
const video = document.getElementById('video')
const ctx = document.getElementById('canvas').getContext('2d', { willReadFrequently: true })
let stream = null
let timer = null
let empty = null // the shop island with nothing on it, from the main process
// While no shop is open: the layout seen on recent frames, waiting for it to hold still.
let seen = { size: 0, still: 0, prev: null, t: 0 }
// While a shop is open: { size, lastFullAt, firstGone, emptyFrames, firstEmptyAt }
let shop = null
const STILL_TICKS = 3

// Share of the shop area (sampled) that differs between two frames.
const AREA = { x0: 700, x1: 1160, y0: 200, y1: 470, step: 4 }
function changed (a, b) {
  let n = 0
  let diff = 0
  for (let y = AREA.y0; y < AREA.y1; y += AREA.step) {
    for (let x = AREA.x0; x < AREA.x1; x += AREA.step) {
      const i = (y * W + x) * 4
      n++
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) diff++
    }
  }
  return diff / n
}

function stop () {
  clearInterval(timer)
  timer = null
  if (stream) stream.getTracks().forEach(t => t.stop())
  stream = null
  shop = null
  seen = { size: 0, still: 0, prev: null, t: 0 }
  island = { checkedAt: 0, last: '', sent: '', sentAt: 0, prev: null, sentSig: null, still: 0, recheck: false }
  round = { checkedAt: 0, last: null, count: 0, sent: null }
  card = { checkedAt: 0, last: '', sent: '', seenAt: 0 }
}

// Canvas pixels are RGBA; the matcher works on BGRA like Electron's screenshots.
const toBgra = px => { for (let i = 0; i < px.length; i += 4) { const r = px[i]; px[i] = px[i + 2]; px[i + 2] = r } return px }
// The video comes at the game's own size; everything is read at 1280x720.
function grab () {
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(video, 0, 0, W, H)
  return { width: W, height: H, data: toBgra(ctx.getImageData(0, 0, W, H).data) }
}

// The island at the game's own size (for a sharper look at small units), when that's well above 1280x720.
// Area in 1280x720 coordinates.
const SHARP_AREA = { x0: 40, y0: 100, x1: 600, y1: 560 }
const sharpCanvas = document.createElement('canvas')
const sharpCtx = sharpCanvas.getContext('2d', { willReadFrequently: true })
function grabSharp () {
  const scale = video.videoWidth / W
  if (!(scale >= 1.4) || Math.abs(video.videoHeight / H - scale) > 0.02) return null
  const x0 = Math.round(SHARP_AREA.x0 * scale)
  const y0 = Math.round(SHARP_AREA.y0 * scale)
  const width = Math.round(SHARP_AREA.x1 * scale) - x0
  const height = Math.round(SHARP_AREA.y1 * scale) - y0
  sharpCanvas.width = width
  sharpCanvas.height = height
  sharpCtx.drawImage(video, x0, y0, width, height, 0, 0, width, height)
  return { scale, x0, y0, width, height, data: toBgra(sharpCtx.getImageData(0, 0, width, height).data) }
}

// Once a second, what the page sees, so a shop that isn't picked up can be looked into
// (written to vision-debug.log next to the shop pictures, with the latest frame as last-frame.png).
let lastDebug = 0
let lastFrameSent = 0
function report (frame, t) {
  if (t - lastDebug < 1000) return
  lastDebug = t
  const info = {
    t,
    video: `${video.videoWidth}x${video.videoHeight}`,
    shop: shop ? shop.size : 0,
    open: SkyVision.shopOpen(frame),
    panel: SkyVision.panelOpen(frame),
    layout: SkyVision.shopLayout(frame, empty),
    seen: seen.size,
    still: seen.still
  }
  if (t - lastFrameSent >= 5000) {
    lastFrameSent = t
    info.frame = { width: W, height: H, data: new Uint8Array(frame.data.buffer.slice(0)) }
  }
  api.debug(info)
}

function tick () {
  if (video.readyState < 2 || !empty) return
  const t = Date.now()
  const frame = grab()
  try { report(frame, t) } catch (err) { api.debug({ t, error: err.message }) }
  watchRound(frame, t)
  watchCard(frame, t)
  if (shop) {
    watchShop(frame, t)
    // The island can be rearranged while a shop is up (the shop stands off to the right of it).
    return watchIsland(frame, t)
  }
  // A shop counts as open once a whole layout of units stands on the island and has
  // stopped moving (units take a moment to spawn in).
  const size = SkyVision.shopLayout(frame, empty)
  if (takenEarly(frame, t, size)) return
  // A frame or two that misses the layout (a sparkle, a passing cursor) doesn't start the wait over.
  if (!size && seen.size && seen.misses < 3) {
    seen.misses++
    seen.prev = frame.data
    return
  }
  if (!size || size !== seen.size) seen = { size, still: 0, prev: null, t, misses: 0, full: seen.full, fullAt: seen.fullAt, fullSize: seen.fullSize, taken: seen.taken }
  else {
    seen.still = changed(frame.data, seen.prev) < 0.002 ? seen.still + 1 : 0
    seen.misses = 0
  }
  seen.prev = frame.data
  // The latest frame with the whole layout on it, in case a unit is taken before the shop settles.
  if (size) { seen.full = frame.data; seen.fullAt = t; seen.fullSize = size; seen.taken = 0 }
  noteUnsure(frame, t, size)
  // Animated units may never hold perfectly still, so a layout that stays put for a second is enough too.
  if (size && (seen.still >= STILL_TICKS || t - seen.t >= 1000)) {
    shop = { size, lastFullAt: t, firstGone: -1, emptyFrames: 0, firstEmptyAt: 0 }
    seen = { size: 0, still: 0, prev: null, t: 0, misses: 0 }
    api.shopOpened({ t, size, width: W, height: H, data: new Uint8Array(frame.data.buffer) })
  }
  if (!size) watchIsland(frame, t)
}

// A unit taken before the shop held still (a fast pick, often while units are still spawning in):
// once a unit has left the layout seen on an earlier frame, or the whole shop is gone, the shop is
// read from that last full frame and the pick worked out as usual. Two frames in a row are needed,
// so a unit flickering as it spawns doesn't count.
function takenEarly (frame, t, size) {
  if (!seen.full || size === seen.fullSize) return false
  // Only a layout seen moments ago: an old one is not this shop.
  if (t - seen.fullAt > 5000) { seen.full = null; return false }
  const filled = SkyVision.slotsFilled(frame, empty, seen.fullSize)
  // A panel or card over the shop says nothing either way.
  if (!filled || filled.some(f => f === null)) return false
  const gone = filled.filter(f => !f).length
  if (!gone) return false
  if (++seen.taken < 2) return false
  const fullSize = seen.fullSize
  shop = { size: fullSize, lastFullAt: seen.fullAt, firstGone: filled.indexOf(false), emptyFrames: 0, firstEmptyAt: 0, early: true }
  api.shopOpened({ t: seen.fullAt, size: fullSize, width: W, height: H, data: new Uint8Array(seen.full.buffer), early: true })
  seen = { size: 0, still: 0, prev: null, t: 0, misses: 0 }
  // Already all gone: the shop closed with the pick.
  if (gone === filled.length) {
    api.shopClosed({ lastOpenAt: shop.lastFullAt, closedAt: t, firstGone: -1 })
    shop = null
  }
  return true
}

// The shop island has been up for two seconds without the app seeing a full shop on it: keep that
// frame (as unsure-*.png) so a missed shop can be looked into.
let unsure = { since: 0, saved: false }
function noteUnsure (frame, t, size) {
  if (size || !SkyVision.shopOpen(frame)) { unsure = { since: 0, saved: false }; return }
  // The bare island between shops is expected; only frames with something standing on it are kept.
  const standing = [1, 3, 6].some(n => (SkyVision.slotsFilled(frame, empty, n) || []).some(Boolean))
  if (!standing) return
  if (!unsure.since) unsure.since = t
  if (unsure.saved || t - unsure.since < 2000) return
  unsure.saved = true
  api.debug({ t, unsure: true, frame: { width: W, height: H, data: new Uint8Array(frame.data.buffer.slice(0)) } })
}

// The round on the counter, read once a second; the main process hears it when it changes (after
// three readings in a row agree), which is how the app knows a new run started.
let round = { checkedAt: 0, last: null, count: 0, sent: null }
function watchRound (frame, t) {
  if (t - round.checkedAt < 1000) return
  round.checkedAt = t
  const n = SkyVision.readRound(frame)
  round.count = n === round.last ? round.count + 1 : 1
  round.last = n
  if (n === null || round.count < 3 || n === round.sent) return
  round.sent = n
  api.round(n)
}

// A unit's card (shown while the mouse rests on a unit) names that unit. Each card is sent once, when
// it's been in the same place on two checks in a row (it may still be fading in on the first).
let card = { checkedAt: 0, last: '', sent: '', seenAt: 0, since: 0 }
const CARD_SETTLE = 1500
function watchCard (frame, t) {
  if (!api.unitCard || t - card.checkedAt < 250) return
  card.checkedAt = t
  const box = SkyVision.unitCard(frame)
  // Two units' cards can come up in exactly the same place (the mouse moving between neighbours), so
  // the title's dark pixels are part of what tells one card from the next.
  const sig = box ? `${box.x0},${box.y0},${box.x1},${box.y1}:${titleSig(SkyVision.cardTitle(frame, box, 1))}` : ''
  const steady = sig === card.last
  // When this card came up: the mouse was resting on its unit then, and may have moved on since.
  if (!steady) card.since = t
  card.last = sig
  if (!box) { card.sent = ''; return }
  card.seenAt = t
  if (!steady || sig === card.sent) return
  card.sent = sig
  api.unitCard({ t: card.since || t, box, title: sharpTitle(box) || SkyVision.cardTitle(frame, box), width: W, height: H, data: new Uint8Array(frame.data.buffer.slice(0)), hi: grabSharp() })
}

// A rough fingerprint of a card's title: how much ink is in each eighth of it, left to right.
function titleSig (title) {
  const cols = new Array(8).fill(0)
  for (let y = 0; y < title.height; y++) {
    for (let x = 0; x < title.width; x++) if (!title.data[y * title.width + x]) cols[Math.floor(x * 8 / title.width)]++
  }
  return cols.map(n => Math.round(n / 20)).join('.')
}

// The card's title read from the game at its own size (sharper letters), when that's above 1280x720.
function sharpTitle (box) {
  const scale = video.videoWidth / W
  if (!(scale >= 1.4)) return null
  const x0 = Math.round(box.x0 * scale)
  const y0 = Math.round(box.y0 * scale)
  const width = Math.round((box.x1 + 1) * scale) - x0
  const height = Math.round((box.y1 + 1) * scale) - y0
  sharpCanvas.width = width
  sharpCanvas.height = height
  sharpCtx.drawImage(video, x0, y0, width, height, 0, 0, width, height)
  const region = { width, height, data: sharpCtx.getImageData(0, 0, width, height).data }
  return SkyVision.cardTitle(region, { x0: 0, y0: 0, x1: width - 1, y1: height - 1 }, Math.max(1, Math.floor(3 / scale)))
}

// The island is read whenever it has settled after a change (a unit put down, moved or sold), and
// every so often anyway. Frames with the grid showing (while dragging a unit, or with Island Stats
// open) go when the grid's pattern changes. The worker decides whether the view is usable.
const ISLAND_EVERY = 300
const ISLAND_AREA = { x0: 60, x1: 570, y0: 110, y1: 545, step: 8 }
let island = { checkedAt: 0, last: '', sent: '', sentAt: 0, prev: null, sentSig: null, still: 0, recheck: false }
// The reader saw something new once and wants another look to confirm it.
if (api.onRecheck) api.onRecheck(() => { island.recheck = true })
function islandSig (frame) {
  const out = []
  for (let y = ISLAND_AREA.y0; y < ISLAND_AREA.y1; y += ISLAND_AREA.step) {
    for (let x = ISLAND_AREA.x0; x < ISLAND_AREA.x1; x += ISLAND_AREA.step) {
      const i = (y * W + x) * 4
      out.push((frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3)
    }
  }
  return out
}
// Share of the island's sample points that changed noticeably.
const sigDiff = (a, b) => a.reduce((n, v, i) => n + (Math.abs(v - b[i]) > 20 ? 1 : 0), 0) / a.length
function watchIsland (frame, t) {
  if (t - island.checkedAt < ISLAND_EVERY) return
  // For a moment after a unit's card goes, the game still tints that unit and its synergy partners
  // green: they'd look gone, and odd shapes would look like new units. (While the card is up the reader
  // sees it and only takes off units that are plainly gone.)
  if (!card.last && t - (card.seenAt || 0) < CARD_SETTLE) return
  island.checkedAt = t
  const send = () => {
    island.recheck = false
    island.sentAt = t
    island.sentSig = sig
    api.islandSeen({ t, width: W, height: H, data: new Uint8Array(frame.data.buffer.slice(0)), hi: grabSharp() })
  }
  const sig = islandSig(frame)
  // Animated units (windmills, glows) keep changing a little, so "steady" allows some of that.
  const steady = island.prev && sigDiff(sig, island.prev) < 0.02
  island.prev = sig
  island.still = steady ? island.still + 1 : 0
  const tiles = SkyVision.islandTiles(frame)
  if (tiles) {
    const now = Object.values(tiles).join('')
    const same = now === island.last
    island.last = now
    const again = island.recheck && t - island.sentAt >= 1000
    if (!same || (now === island.sent && t - island.sentAt < 10000 && !again)) return
    island.sent = now
    return send()
  }
  island.last = ''
  // Without the grid: once it has held still for a moment, every 5 seconds if anything changed since
  // the last reading, else every 15.
  if (island.still < 2) return
  const since = t - island.sentAt
  if (island.recheck && since >= 1000) return send()
  if (since < 5000 || (island.sentSig && sigDiff(sig, island.sentSig) < 0.002 && since < 15000)) return
  send()
}

// The shop closes when its units are all gone (two frames in a row, so a passing tooltip doesn't count).
function watchShop (frame, t) {
  // null = something (a unit's card, the Tips panel) covers the shop, so this frame says nothing.
  const filled = SkyVision.slotsFilled(frame, empty, shop.size)
  if (!filled) return
  if (filled.every(f => f !== false)) {
    shop.lastFullAt = t
    shop.firstGone = -1
  } else if (shop.firstGone < 0) {
    shop.firstGone = filled.indexOf(false)
  }
  if (filled.some(f => f !== false)) {
    shop.emptyFrames = 0
    return
  }
  if (++shop.emptyFrames === 1) shop.firstEmptyAt = t
  if (shop.emptyFrames >= 2) {
    api.shopClosed({ lastOpenAt: shop.lastFullAt, closedAt: shop.firstEmptyAt, firstGone: shop.firstGone })
    shop = null
  }
}

api.onStart(async ref => {
  stop()
  empty = ref
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: { ideal: 15 } } })
    stream.getVideoTracks()[0].addEventListener('ended', () => { stop(); api.ended() })
    video.srcObject = stream
    await video.play()
    timer = setInterval(tick, TICK_MS)
    api.started()
  } catch (err) {
    stop()
    api.ended(err.message)
  }
})
api.onStop(stop)
