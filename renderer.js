/* global SkyCore */
const core = SkyCore
const api = window.skyshard

const SVG_NS = 'http://www.w3.org/2000/svg'
const TILE = 40
const REC_PAGE = 12
const SHOP_LIMIT = 8

const state = {
  data: null,
  byId: new Map(),
  log: { status: 'waiting' },
  rawLog: { status: 'waiting' }, // the log as read; log hides it when it's from a run that has ended
  endedRun: savedEndedRun(),
  screenRound: null, // the round on the game's counter
  view: 'build',
  bought: [],
  selected: null,
  hoverRec: null,
  costFilter: 0,
  recLimit: REC_PAGE,
  vision: { status: 'off' },
  readShops: true,
  shop: null,
  // The units on your island as the app believes it: from the log, kept up to date from the screen.
  roster: [],
  removed: [], // [{ piece, at }] units recently taken off the island, newest first (to put back)
  boughtSince: 0, // when the first unit of this round was bought
  islandView: null, // what the last reading of the island said about the view: 'ok', 'moved', 'unknown' or 'card' (a unit's card is up)
  islandSeenAt: 0,
  placing: null, // { ref, id } while the player picks a tile for a unit
  lookingFor: ''
}

const $ = id => document.getElementById(id)

// The run the player has moved on from (its first build code), kept across restarts of the app.
function savedEndedRun () {
  try { return localStorage.getItem('endedRun') } catch { return null }
}
function saveEndedRun (key) {
  try { key ? localStorage.setItem('endedRun', key) : localStorage.removeItem('endedRun') } catch {}
}

// Small DOM builder: el('div', { class: 'x', onclick: fn }, child, 'text', ...)
function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (k === 'style') Object.assign(node.style, v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c)
  return node
}

function svg (tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v)
  }
  for (const c of children.flat()) if (c != null) node.append(c)
  return node
}

const unitOf = id => state.byId.get(id) || { id, name: `Unit #${id}`, faction: 0, rarity: 0, w: 1, h: 1, synergy: [], conditional: [], info: '' }
const dot = faction => el('span', { class: `dot f${faction}` })
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function currentBoard () {
  return state.view === 'opponent' ? state.log.opponent || [] : myIsland()
}

// The units on your island: the log's board, kept up to date from what the game screen shows.
function myIsland () {
  return state.roster
}

// What you own for suggestions: what stands on your island. (Units in the inventory don't count
// until they're put down; the app can't tell them from sold ones.)
function ownedIds () {
  return myIsland().map(p => p.id)
}

/* ---------- Island ---------- */

function labelFor (name, w, h) {
  const words = name.split(' ')
  for (let size = Math.min(13, h * 0.42); size >= 6; size -= 0.5) {
    const perLine = Math.floor((w - 4) / (size * 0.6))
    if (words.some(word => word.length > perLine)) continue
    const lines = []
    let line = ''
    for (const word of words) {
      if (line && (line + ' ' + word).length > perLine) { lines.push(line); line = word } else line = line ? line + ' ' + word : word
    }
    lines.push(line)
    if (lines.length * size * 1.15 <= h - 4) return { size, lines }
  }
  return { size: 6, lines: [name.slice(0, Math.max(3, Math.floor(w / 4)))] }
}

function renderIsland () {
  const host = $('island')
  host.replaceChildren()
  const board = currentBoard()
  if (!board.length && !(state.view === 'build' && state.placing)) {
    host.append(el('div', { class: 'empty' }, state.view === 'opponent'
      ? 'No opponent board yet. It appears once a fight starts.'
      : emptyMessage()))
    return
  }
  const rows = core.ISLAND_ROWS
  const root = svg('svg', { viewBox: `0 0 ${core.ISLAND_COLS * TILE} ${rows.length * TILE}`, role: 'img' })
  const placing = state.view === 'build' && state.placing
  rows.forEach((width, r) => {
    const start = (core.ISLAND_COLS - width) / 2
    for (let c = 0; c < width; c++) {
      const tile = { x: start + c - core.ISLAND_OFFSET, y: r - core.ISLAND_OFFSET }
      root.append(svg('rect', {
        class: placing ? 'cell pick' : 'cell',
        'data-tile': `${tile.x},${tile.y}`,
        onmouseenter: placing ? () => showFootprint(root, tile) : null,
        x: (start + c) * TILE,
        y: r * TILE,
        width: TILE,
        height: TILE,
        rx: 4,
        onclick: placing ? () => placeAt(tile) : null
      }))
    }
  })

  const highlight = highlightSet()
  for (const piece of board) {
    const u = unitOf(piece.id)
    const x = (piece.x + core.ISLAND_OFFSET) * TILE
    const y = (piece.y - u.h + 1 + core.ISLAND_OFFSET) * TILE
    const w = u.w * TILE
    const h = u.h * TILE
    const { size, lines } = labelFor(u.name, w, h)
    const cx = x + w / 2
    const y0 = y + h / 2 - ((lines.length - 1) * size * 1.15) / 2
    let cls = 'unit'
    if (highlight) cls += highlight.has(piece.id) ? ' glow' : ' dim'
    if (state.selected === piece.id) cls += ' selected'
    // Dashed until the game's log has the unit at that spot too.
    if (!piece.inLog && (piece.how === 'seen' || piece.how === 'manual')) cls += ' seen'
    if (placing) cls += ' passive'
    const enchants = (piece.enchants || []).length ? ` · ${plural(piece.enchants.length, 'enchantment')}` : ''
    root.append(svg('g', { class: cls, onclick: () => selectUnit(piece.id, piece.key) },
      svg('title', {}, `${u.name}${enchants}${howText(piece)}\n${u.info}`),
      svg('rect', { class: `f${u.faction}`, x: x + 2, y: y + 2, width: w - 4, height: h - 4, rx: 5 }),
      svg('text', { x: cx, y: y0, 'font-size': size.toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'central' },
        lines.map((line, i) => svg('tspan', { x: cx, dy: i ? (size * 1.15).toFixed(1) : 0 }, line))),
      (piece.enchants || []).length ? svg('circle', { class: 'ench', cx: x + w - 9, cy: y + 9, r: 3.5 }) : null
    ))
  }
  if (placing) root.addEventListener('mouseleave', () => showFootprint(root, null))
  host.append(root)
}

// While placing, the tiles the unit would cover light up under the mouse (red where it won't fit).
function howText (piece) {
  if (piece.inLog) return ''
  if (piece.card) return '\nNamed from its card in the game'
  return piece.how === 'manual' ? '\nPlaced by you' : piece.how === 'seen' ? '\nSeen in the game' : ''
}

function showFootprint (root, tile) {
  const keys = new Set()
  if (tile) {
    const u = unitOf(state.placing.id)
    const { x, y } = anchorFor(u, tile)
    for (const k of core.footprint(x, y, u.w, u.h)) keys.add(k)
  }
  const fits = [...keys].every(k => core.onIsland(k))
  for (const cell of root.querySelectorAll('.cell')) {
    const on = keys.has(cell.dataset.tile)
    cell.classList.toggle('hot', on && fits)
    cell.classList.toggle('bad', on && !fits)
  }
}

// When a suggestion is hovered, light up the board units it works with.
function highlightSet () {
  if (state.view !== 'build' || state.hoverRec == null) return null
  const rec = unitOf(state.hoverRec)
  const ids = new Set()
  for (const piece of myIsland()) {
    const o = unitOf(piece.id)
    if (o.synergy.includes(rec.id) || rec.synergy.includes(o.id)) ids.add(o.id)
  }
  return ids
}

function emptyMessage () {
  const s = state.log.status
  if (s === 'missing') return `Can't find the game log at ${state.log.path}. Start Skyshard, or choose the log file.`
  if (s === 'new-run') return 'New run: nothing on your island yet. Units you buy show up here.'
  if (s === 'no-build') return 'No board in the log yet. The game writes its log in batches, so your island can appear a round or two late.'
  return 'Waiting for the game log…'
}

function renderLegend () {
  $('legend').replaceChildren(...core.FACTIONS.map((name, i) => el('span', { class: 'chip' }, dot(i), name)),
    el('span', { class: 'chip' }, '○ enchanted'))
}

function renderSummary () {
  const host = $('summary')
  host.replaceChildren()
  const board = currentBoard()
  if (!board.length) return
  const s = core.summarize(board, state.byId)
  const stat = (value, label) => el('div', { class: 'stat' }, el('b', {}, String(value)), el('span', {}, label))
  const breakdown = (title, parts, colour) => {
    const total = parts.reduce((sum, p) => sum + p.n, 0) || 1
    return el('div', { class: 'group' },
      el('h2', {}, title),
      el('div', { class: 'bars' }, parts.map((p, i) => el('span', {
        class: colour ? `f${core.FACTIONS.indexOf(p.label)}` : null,
        style: { width: `${(100 * p.n) / total}%`, background: colour ? null : `hsl(${215 + i * 38} 55% ${48 + (i % 2) * 10}%)` }
      }))),
      el('div', { class: 'bar-labels' }, parts.map(p => el('span', {}, `${p.label} ${p.n}`))))
  }
  host.append(
    stat(s.units, 'units'),
    stat(s.mana, 'mana on board'),
    stat(new Set(board.map(p => p.id)).size, 'different units'),
    breakdown('Factions', s.factions, true),
    breakdown('Type', s.types),
    breakdown('Role', s.roles)
  )
}

function selectUnit (id, key = null) {
  state.selected = state.selected === id ? null : id
  state.selectedKey = state.selected == null ? null : key
  renderIsland()
  renderDetail()
}

function renderDetail () {
  const host = $('detail')
  if (state.selected == null) { host.hidden = true; return }
  const u = unitOf(state.selected)
  const names = ids => ids.map(id => unitOf(id).name).join(', ')
  const stats = [
    `Tier ${u.rarity}`,
    core.FACTIONS[u.faction],
    core.TYPES[u.type],
    core.ROLES[u.role],
    `${u.health} health`,
    u.damage ? `${u.damage} damage` : null,
    `${u.w}×${u.h} tiles`
  ].filter(Boolean).join(' · ')
  host.hidden = false
  host.replaceChildren(el('div', {},
    el('h3', {}, dot(u.faction), ' ', u.name),
    el('p', { class: 'muted' }, stats),
    el('p', {}, u.info),
    u.synergy.length ? el('p', {}, el('span', { class: 'muted' }, 'Works with: '), names(u.synergy)) : null,
    u.conditional.length ? el('p', {}, el('span', { class: 'muted' }, 'Appears in shops once you own: '), names(u.conditional)) : null,
    state.view === 'build' && state.selectedKey
      ? el('button', { type: 'button', class: 'link', onclick: () => takeOffIsland(state.selectedKey) }, 'Not on my island anymore')
      : null
  ))
}

/* ---------- Suggestions ---------- */

function renderRecs (recs) {
  const list = $('recs')
  list.replaceChildren()
  $('recCount').textContent = recs.length ? `${recs.length} units fit` : ''
  if (!ownedIds().length) {
    list.append(el('li', { class: 'muted' }, 'Suggestions appear once your island is loaded.'))
    $('recMore').hidden = true
    return
  }
  for (const r of recs.slice(0, state.recLimit)) {
    const u = r.unit
    const why = r.reasons.slice(0, 4).map(x => x.weight > 1 ? `${x.name} (both ways)` : x.name)
    const extra = r.reasons.length > 4 ? ` and ${r.reasons.length - 4} more` : ''
    list.append(el('li', {
      onmouseenter: () => { state.hoverRec = u.id; renderIsland() },
      onmouseleave: () => { state.hoverRec = null; renderIsland() }
    },
    el('div', { class: 'rec-name' }, dot(u.faction), u.name,
      el('span', { class: 'tag' }, `Tier ${u.rarity}`),
      r.owned ? el('span', { class: 'tag owned' }, `own ${r.owned}`) : null),
    el('div', { class: 'rec-actions' },
      el('span', { class: 'score', title: 'Synergy links with your board' }, `+${r.score}`),
      el('button', { type: 'button', title: 'Add to "Bought this round"', onclick: () => addBought(u.id) }, 'Bought')),
    el('div', { class: 'rec-why' }, `Works with ${why.join(', ')}${extra}`)))
  }
  $('recMore').hidden = recs.length <= state.recLimit
}

function renderShops (recs, owned) {
  const list = $('shops')
  list.replaceChildren()
  if (!ownedIds().length) {
    list.append(el('li', { class: 'muted' }, 'Shop picks appear once your island is loaded.'))
    return
  }
  const shops = state.data.shops.filter(s => !state.costFilter || s.cost === state.costFilter)
  const scored = core.scoreShops(shops, state.data.units, owned, recs).slice(0, SHOP_LIMIT)
  for (const s of scored) {
    const pct = Math.round(s.chance * 100)
    const shown = s.fits.slice(0, 5).map(u => u.name).join(', ')
    const more = s.fits.length > 5 ? ` +${s.fits.length - 5}` : ''
    list.append(el('li', {},
      el('div', {},
        el('div', { class: 'shop-name' }, s.shop.name),
        el('div', { class: 'shop-meta' }, `${s.shop.cost} mana · Tier ${s.shop.tiers.join('/')} · ${s.shop.info}`)),
      el('div', { class: `chance ${pct >= 60 ? 'high' : pct >= 30 ? 'mid' : ''}` }, `${pct}%`),
      el('div', { class: 'meter' }, el('span', { style: { width: `${pct}%` } })),
      el('div', { class: 'shop-fits' }, s.fits.length
        ? `${s.fits.length} of ${s.poolSize} possible units are top picks: ${shown}${more}`
        : `None of its ${s.poolSize} possible units are top picks`)))
  }
}

function renderCostFilter () {
  const host = $('costFilter')
  host.replaceChildren(...[0, 1, 2, 3, 4, 5].map(cost => el('button', {
    type: 'button',
    class: state.costFilter === cost ? 'active' : null,
    title: cost ? `Shops costing ${cost} mana` : 'All shops',
    onclick: () => { state.costFilter = cost; renderCostFilter(); renderAdvice() }
  }, cost ? String(cost) : 'All')))
}

function renderUnlocks (owned) {
  const list = core.unlocks(owned, state.data.units)
  $('unlockPanel').hidden = !list.length
  $('unlocks').replaceChildren(...list.map(u => el('li', { class: 'chip', title: u.info }, dot(u.faction), u.name)))
}

/* ---------- Shop on screen ---------- */

const VISION_TEXT = {
  off: ['Off', 'Shop reading is off.'],
  'no-art': ['No unit art', 'Shop reading needs the unit pictures in the unit-art folder.'],
  looking: ['Game not found', 'Start Skyshard to read your shops. Fullscreen or borderless windowed works best.'],
  watching: ['Watching', 'Open a shop in the game and its units show up here.'],
  error: ['Stopped', 'Shop reading hit an error and stopped. Turn it off and on to retry.']
}

const slotUnit = slot => slot.choice != null ? slot.choice : slot.options[0].id

function onShopEvent (e) {
  if (e.type === 'opening') {
    state.shop = { id: e.id, reading: true, slots: [], picked: null, closed: false }
  } else if (!state.shop || state.shop.id !== e.id) {
    return
  } else if (e.type === 'shop') {
    Object.assign(state.shop, { reading: false, size: e.size, slots: e.slots.map(sl => ({ ...sl, choice: null })) })
    // Cards hovered while the shop was still being read.
    const cards = state.shop.cards || {}
    for (const i of Object.keys(cards)) if (state.shop.slots[i]) Object.assign(state.shop.slots[i], { choice: cards[i], sure: true })
    if (Object.keys(cards).length) sendLabel()
  } else if (e.type === 'card') {
    // The unit's card was up over a shop slot: its name says what's there.
    const slot = state.shop.slots[e.slot]
    if (state.shop.reading) state.shop.cards = { ...state.shop.cards, [e.slot]: e.unit }
    else if (slot && !(slot.sure && slotUnit(slot) === e.unit)) return chooseUnit(e.slot, e.unit)
    else return
  } else if (e.type === 'failed') {
    state.shop = null
  } else if (e.type === 'pick') {
    state.shop.closed = true
    if (e.slot >= 0 && state.shop.picked === null) return takeFromShop(e.slot)
  }
  renderAll()
}

function sendLabel () {
  const shop = state.shop
  api.labelShop({ id: shop.id, units: shop.slots.map(slotUnit), picked: shop.picked })
}

// Records the unit taken from the shop as bought this round.
function takeFromShop (index) {
  const shop = state.shop
  if (shop.picked !== null) {
    // Moving the pick to another slot: undo the earlier one.
    dropBought(slotUnit(shop.slots[shop.picked]))
  }
  shop.picked = index
  sendLabel()
  addBought(slotUnit(shop.slots[index]))
}

// Takes back one purchase of a unit (both units, for ones that come with a copy).
function dropBought (id) {
  for (let n = core.copiesPerBuy(unitOf(id)); n > 0; n--) {
    const at = state.bought.lastIndexOf(id)
    if (at >= 0) state.bought.splice(at, 1)
  }
}

// Corrects what is in a slot; if that unit was already counted as bought, swap it.
function chooseUnit (index, id) {
  const slot = state.shop.slots[index]
  const before = slotUnit(slot)
  slot.choice = id
  slot.sure = true
  sendLabel()
  if (state.shop.picked === index && before !== id) {
    dropBought(before)
    addBought(id)
    return
  }
  renderAll()
}

function otherUnitInput (index) {
  const input = el('input', { list: 'unitNames', placeholder: 'Other unit…', class: 'other-unit' })
  const commit = () => {
    const unit = state.data.units.find(u => u.name.toLowerCase() === input.value.trim().toLowerCase())
    if (unit) chooseUnit(index, unit.id)
  }
  input.addEventListener('change', commit)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') commit() })
  return input
}

function renderShopNow (recs) {
  const [short, long] = VISION_TEXT[state.vision.status] || VISION_TEXT.off
  $('visionStatus').textContent = short
  $('visionStatus').title = state.vision.window ? `Watching the window "${state.vision.window}"` : ''
  $('readShops').textContent = `Shop reading: ${state.readShops ? 'on' : 'off'}`
  const host = $('shopNow')
  const shop = state.shop
  if (!shop) {
    host.replaceChildren(el('p', { class: 'hint' }, long))
    return
  }
  if (shop.reading) {
    host.replaceChildren(el('p', { class: 'hint' }, 'Reading the shop…'))
    return
  }
  const recOf = new Map(recs.map((r, i) => [r.unit.id, { score: r.score, rank: i + 1 }]))
  const scores = shop.slots.map(sl => (recOf.get(slotUnit(sl)) || { score: 0 }).score)
  const best = Math.max(...scores)
  const head = shop.picked !== null
    ? `You took ${unitOf(slotUnit(shop.slots[shop.picked])).name}. It's in "Bought this round". Wrong one? Press "Took this" on the right unit.`
    : shop.closed ? 'Shop closed, but the app couldn\'t tell which unit you took. Press "Took this" on it.' : 'Pick the unit that fits your board best.'
  host.replaceChildren(
    el('p', { class: 'hint' }, head),
    el('ol', { class: 'shop-now' }, shop.slots.map((slot, i) => {
      const u = unitOf(slotUnit(slot))
      const rec = recOf.get(u.id)
      const others = slot.sure ? [] : slot.options.filter(o => o.id !== u.id).slice(0, 4)
      return el('li', { class: shop.picked === i ? 'taken' : null },
        el('div', { class: 'rec-name' }, dot(u.faction), slot.sure ? u.name : `${u.name}?`,
          el('span', { class: 'tag' }, `Tier ${u.rarity}`),
          best > 0 && scores[i] === best ? el('span', { class: 'tag best' }, 'Best pick') : null,
          shop.picked === i ? el('span', { class: 'tag owned' }, 'Taken') : null),
        el('div', { class: 'rec-actions' },
          rec ? el('span', { class: 'score', title: 'Synergy links with your board' }, `+${rec.score}`) : null,
          shop.picked !== i ? el('button', { type: 'button', onclick: () => { takeFromShop(i); renderAll() } }, 'Took this') : null),
        el('div', { class: 'rec-why' }, rec ? `#${rec.rank} of your suggestions` : 'No synergy with your board'),
        slot.sure ? null : el('div', { class: 'rec-why unsure' }, 'Unsure. Was it ',
          others.flatMap((o, n) => [n ? ', ' : '', el('button', { type: 'button', class: 'link', onclick: () => chooseUnit(i, o.id) }, unitOf(o.id).name)]),
          others.length ? ' or ' : '', otherUnitInput(i), '?'))
    })))
}

/* ---------- Bought this round ---------- */

function addBought (id) {
  if (!state.byId.has(id)) return
  // A unit can be put down before the app has worked out the pick, so count from a bit earlier.
  if (!state.bought.length) state.boughtSince = Date.now() - 30000
  for (let n = core.copiesPerBuy(unitOf(id)); n > 0; n--) state.bought.push(id)
  renderAll()
}

function renderBought () {
  $('clearBought').hidden = !state.bought.length
  $('bought').replaceChildren(...state.bought.map((id, i) => {
    const u = unitOf(id)
    return el('li', { class: 'chip' }, dot(u.faction), u.name,
      el('button', { type: 'button', title: 'Remove', onclick: () => { state.bought.splice(i, 1); renderAll() } }, '×'))
  }))
}

function addFromInput () {
  const input = $('boughtInput')
  const name = input.value.trim().toLowerCase()
  const unit = state.data.units.find(u => u.name.toLowerCase() === name)
  if (!unit) { input.select(); return }
  input.value = ''
  addBought(unit.id)
}

/* ---------- Island changes seen in the game ---------- */

// Keeps units taken off the island for a while, so a mistake can be undone.
function noteRemoved (pieces, { byHand = false } = {}) {
  const at = Date.now()
  const back = new Set(state.roster.map(p => p.key)) // seen again since: nothing to put back
  state.removed = [...pieces.map(piece => ({ piece, at, byHand })), ...state.removed].filter(r => !back.has(r.piece.key)).slice(0, 8)
}

// A reading of the island from the game (the worker reads it whenever it changes).
// How many of each unit the last board from the log and this round's purchases account for, or null
// when the log has no board yet.
function ownedCopies () {
  const build = state.log && state.log.build
  if (!build || !build.length) return null
  const out = new Map()
  for (const id of [...build.map(b => b.id), ...state.bought]) out.set(id, (out.get(id) || 0) + 1)
  return out
}

function onIsland (reading) {
  state.islandView = reading.view
  if (reading.view === 'ok' || reading.view === 'card') {
    const { roster, removed } = core.trackIsland(state.roster, reading, state.byId, reading.at, { bought: state.bought, owned: ownedCopies() })
    state.roster = roster
    noteRemoved(removed)
    if (reading.view === 'ok') state.islandSeenAt = reading.at
  }
  renderAll()
}

// A unit's card was up in the game with the mouse on that unit: it stands at spot { id, x, y }.
function onUnitCard (spot) {
  if (!state.byId.get(spot.id) || !core.onIsland(`${spot.x},${spot.y}`)) return
  // How the other copies of this unit looked just before the card came up (checked by the island reader).
  const reading = { view: 'ok', verified: spot.others || [], ground: [], covered: [] }
  const { roster, removed } = core.nameFromCard(state.roster, { id: spot.id, x: spot.x, y: spot.y }, state.byId, Date.now(), { reading })
  state.roster = roster
  noteRemoved(removed)
  renderAll()
}

// Bought units not on the island yet.
function unplaced () {
  return core.unplacedBought(state.roster, state.bought, state.boughtSince)
}

// How long the island reader looks harder for a unit the app just lost track of.
const MISSING_FOR = 90 * 1000

// Units the island reader took off lately (not ones the player took off) that haven't turned up again:
// most likely moved, so the reader looks harder for them for a while.
function missingUnits () {
  const now = Date.now()
  const out = new Set()
  for (const r of state.removed) {
    if (r.byHand || now - r.at > MISSING_FOR) continue
    if (state.roster.some(p => p.id === r.piece.id && p.at >= r.at)) continue
    out.add(r.piece.id)
  }
  return [...out]
}

// Tells the island reader what the app thinks is there, what was bought (likely to turn up), and
// what went missing (likely moved).
function syncLookFor () {
  const hints = unplaced()
  const missing = missingUnits()
  const pieces = myIsland().map(p => ({ key: p.key, id: p.id, x: p.x, y: p.y }))
  const key = JSON.stringify([hints, missing, pieces])
  if (key === state.lookingFor) return
  state.lookingFor = key
  api.lookFor({ hints, missing, pieces })
}

function startPlacing (ref, id) {
  state.placing = state.placing && state.placing.ref === ref && state.placing.id === id ? null : { ref, id }
  if (state.view !== 'build') document.querySelector('.tab[data-view="build"]').click()
  else renderAll()
}

// A unit centred on a tile: its bottom-left tile.
function anchorFor (u, tile) {
  return { x: tile.x - Math.floor((u.w - 1) / 2), y: tile.y + Math.floor((u.h - 1) / 2) }
}

// The player clicked the tile a unit stands on: that tile is about the middle of the unit.
function placeAt (tile) {
  const { ref, id } = state.placing
  const { x, y } = anchorFor(unitOf(id), tile)
  putOnIsland(id, x, y)
  if (ref.startsWith('removed:')) state.removed = state.removed.filter(r => r.piece.key !== ref.slice(8))
  state.placing = null
  renderAll()
}

// Puts a unit on the island by hand; whatever stood on those tiles is taken off.
function putOnIsland (id, x, y) {
  const { roster, removed } = core.placePiece(state.roster, id, x, y, state.byId, Date.now())
  state.roster = roster
  noteRemoved(removed)
}

// The player says a unit shown on the island isn't there anymore.
function takeOffIsland (key) {
  const gone = state.roster.filter(p => p.key === key)
  state.roster = state.roster.filter(p => p.key !== key)
  noteRemoved(gone, { byHand: true })
  state.selected = state.selectedKey = null
  renderAll()
}

// Puts a unit the app took off back where it was.
function putBack (key) {
  const r = state.removed.find(q => q.piece.key === key)
  if (!r) return
  state.removed = state.removed.filter(q => q !== r)
  putOnIsland(r.piece.id, r.piece.x, r.piece.y)
  renderAll()
}

function renderMissing () {
  const rows = []
  const row = (u, note, ...buttons) => el('li', { class: 'missing-row' },
    el('span', {}, dot(u.faction), ' ', u.name), el('span', { class: 'muted' }, note), el('span', { class: 'missing-actions' }, buttons))
  const placeButton = (ref, id) => el('button', {
    type: 'button',
    class: state.placing && state.placing.ref === ref && state.placing.id === id ? 'link active' : 'link',
    onclick: () => startPlacing(ref, id)
  }, state.placing && state.placing.ref === ref && state.placing.id === id ? 'Cancel' : 'Place')
  for (const id of unplaced()) rows.push(row(unitOf(id), 'Bought, not on your island yet', placeButton('bought', id)))
  for (const { piece, at } of state.removed) {
    rows.push(row(unitOf(piece.id), `Taken off your island at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
      el('button', { type: 'button', class: 'link', onclick: () => putBack(piece.key) }, 'Put back'),
      placeButton(`removed:${piece.key}`, piece.id)))
  }
  $('missingPanel').hidden = state.view !== 'build' || !rows.length
  $('missing').replaceChildren(...rows)
  const placing = state.placing && state.view === 'build'
  $('addUnit').hidden = state.view !== 'build'
  $('placeHint').hidden = !placing
  if (placing) $('placeHint').textContent = `Click the tile where ${unitOf(state.placing.id).name} stands on your island.`
}

/* ---------- Status ---------- */

function renderStatus () {
  const s = state.log
  const status = $('status')
  status.className = 'status'
  if (s.status === 'ok') {
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : ''
    const round = s.round ? `Round ${s.round}${s.mode ? ` (${s.mode})` : ''} · ` : ''
    status.textContent = `${round}Board updated ${when}`
    status.classList.add('ok')
  } else if (s.status === 'missing') {
    status.textContent = `Log not found: ${s.path}`
    status.classList.add('warn')
  } else if (s.status === 'new-run') {
    status.textContent = 'New run. Your island starts empty; the game writes this run to its log a little later.'
    status.classList.add('ok')
  } else if (s.status === 'stale') {
    status.textContent = 'New game started. Showing your last board until the game writes this run to its log.'
    status.classList.add('warn')
  } else if (s.status === 'no-build') {
    status.textContent = 'Watching the log. Your board appears once the game writes your first round.'
  } else {
    status.textContent = 'Waiting for the game log…'
  }
  status.title = s.path || ''
  const board = currentBoard()
  let seen = state.view === 'build' && state.islandSeenAt ? ` · checked in game ${new Date(state.islandSeenAt).toLocaleTimeString()}` : ''
  if (state.view === 'build' && state.islandView === 'moved') seen += ' · paused: the game view moved (drag a unit or open Island Stats to resume)'
  if (state.view === 'build' && state.islandView === 'unknown') seen += ' · drag a unit or open Island Stats once so the app can find your island'
  $('boardMeta').textContent = board.length ? plural(board.length, 'unit') + seen : ''
  $('foot').textContent = state.data ? `Game data: patch ${state.data.patch} (${state.data.source}) from SkyShard-Public · Watching ${s.path || '…'}` : ''
}

/* ---------- Wiring ---------- */

function renderAdvice () {
  const owned = core.ownedCounts(ownedIds())
  const recs = core.recommend(owned, state.data.units, state.byId)
  renderRecs(recs)
  renderShopNow(recs)
  renderShops(recs, owned)
  renderUnlocks(owned)
}

function renderAll () {
  renderStatus()
  renderIsland()
  renderMissing()
  syncLookFor()
  renderSummary()
  renderDetail()
  renderBought()
  renderAdvice()
  saveRound()
}

// Your island and what you bought, kept so restarting the app mid-run doesn't lose them. They belong
// to the run the log is on (and the bought list to the log's board, which a new round replaces).
function boardKey (log) {
  return JSON.stringify([log.runKey || null, log.build || null])
}
function saveRound () {
  if (!state.restored) return
  const saved = { run: state.rawLog.runKey || null, board: boardKey(state.rawLog), roster: state.roster, removed: state.removed, bought: state.bought, boughtSince: state.boughtSince, at: Date.now() }
  try { localStorage.setItem('island', JSON.stringify(saved)) } catch {}
}
function restoreRound () {
  state.restored = true
  try {
    const saved = JSON.parse(localStorage.getItem('island'))
    if (!saved) return
    // While the app runs it keeps the last board when the game starts a new log, so the saved run can
    // be the previous log's while a fresh start sees a log with no boards yet. That's no sign of a new
    // run (the round counter catches those), so a recently saved island is kept then too; an old one
    // could be yesterday's run, with today's starting on round 1.
    const run = state.rawLog.runKey || null
    if (run ? saved.run !== run : saved.run && !(Date.now() - saved.at < 30 * 60 * 1000)) return
    state.roster = saved.roster || []
    state.removed = saved.removed || []
    if (saved.board === boardKey(state.rawLog) || !run) {
      state.bought = saved.bought || []
      state.boughtSince = saved.boughtSince || 0
    }
  } catch {}
}

function setData (data) {
  state.data = data
  state.byId = core.indexUnits(data.units)
  $('unitNames').replaceChildren(...data.units.filter(u => u.inShop).map(u => el('option', { value: u.name })))
  $('allUnitNames').replaceChildren(...data.units.map(u => el('option', { value: u.name })))
}

function setLog (log) {
  state.rawLog = log
  // The game can write the end of the last run after a new one has started; that board isn't yours anymore.
  if (state.endedRun && log.runKey === state.endedRun) {
    state.log = { ...log, status: 'new-run', build: [], opponent: null }
    renderAll()
    return
  }
  if (state.endedRun && log.runKey) { state.endedRun = null; saveEndedRun(null) }
  if (log.status === 'ok' && log.round) state.boardRound = log.round
  // A new board from the game: what was bought mid-round is on it (or in the inventory). Its units
  // are added where the island has nothing; the screen is newer than the log, so it wins elsewhere.
  if (log.newBuild && log.updatedAt !== state.log.updatedAt) {
    state.bought = []
    state.boughtSince = 0
    state.roster = core.mergeLog(state.roster, log.build, state.byId, Date.now())
    state.placing = null
  }
  state.log = log
  if (state.selected != null && !currentBoard().some(p => p.id === state.selected)) state.selected = null
  renderAll()
}

// The round on the game's counter. Going to 1, or well below the round of the board from the log,
// means a new run (the log can be a whole run behind, e.g. when the app starts on round 2).
function onScreenRound (n) {
  const before = state.screenRound
  state.screenRound = n
  // The round of the last board the log gave, even after the game rotated the log at start-up.
  const logRound = state.boardRound
  // Two rounds below the log, so one misread digit can't throw your board away.
  // Already on round 1 when the app starts isn't a change; the log check covers a new run then.
  if ((n === 1 && before !== null && before !== 1) || (logRound && n < logRound - 1)) newRun()
}

// A new run started: start from an empty island, whatever the log still says.
function newRun () {
  const log = state.rawLog
  if (log.build && log.build.length && log.round !== 1 && log.runKey) {
    state.endedRun = log.runKey
    saveEndedRun(log.runKey)
  }
  state.bought = []
  state.boughtSince = 0
  state.boardRound = null
  state.roster = []
  state.removed = []
  state.placing = null
  state.shop = null
  api.newRun()
  // The log may already be on this run (its first round): then its board is the start.
  if (!state.endedRun && log.build) state.roster = core.mergeLog([], log.build, state.byId, Date.now())
  state.log = { status: 'waiting', updatedAt: log.updatedAt }
  setLog(log)
}

function setLogButtons ({ customLog }) {
  $('resetLog').hidden = !customLog
}

async function init () {
  renderLegend()
  renderCostFilter()
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab))
    state.view = tab.dataset.view
    state.selected = null
    renderAll()
  }))
  $('recMore').addEventListener('click', () => { state.recLimit += REC_PAGE; renderAdvice() })
  $('addBought').addEventListener('click', addFromInput)
  $('boughtInput').addEventListener('keydown', e => { if (e.key === 'Enter') addFromInput() })
  $('clearBought').addEventListener('click', () => { state.bought = []; renderAll() })
  $('chooseLog').addEventListener('click', async () => setLogButtons(await api.chooseLog()))
  $('resetLog').addEventListener('click', async () => setLogButtons(await api.resetLog()))
  $('openCaptures').addEventListener('click', () => api.openCaptures())
  $('readShops').addEventListener('click', async () => {
    state.readShops = !state.readShops
    state.vision = await api.setReadShops(state.readShops)
    if (!state.readShops) state.shop = null
    renderAll()
  })

  const initial = await api.getState()
  setData(initial.data)
  setLogButtons(initial)
  api.onData(data => { setData(data); renderAll() })
  api.onLog(setLog)
  api.onRound(onScreenRound)
  api.onVision(v => { state.vision = v; renderAll() })
  api.onShop(onShopEvent)
  api.onIsland(onIsland)
  if (api.onUnitCard) api.onUnitCard(onUnitCard)
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.placing) { state.placing = null; renderAll() } })
  const addInput = $('addUnitInput')
  const addUnit = () => {
    const unit = state.data.units.find(u => u.name.toLowerCase() === addInput.value.trim().toLowerCase())
    if (!unit) return
    addInput.value = ''
    state.placing = null
    startPlacing('add', unit.id)
  }
  addInput.addEventListener('change', addUnit)
  addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addUnit() })
  state.vision = initial.vision || state.vision
  state.readShops = initial.vision ? initial.vision.status !== 'off' : true
  setLog(initial.log)
  restoreRound()
  renderAll()
}

init()
