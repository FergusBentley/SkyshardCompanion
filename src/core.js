// Shared game logic. Loaded by the main process (require) and the renderer (<script>).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.SkyCore = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const FACTIONS = ['Basic', 'Tinker', 'Magic', 'Ancient', 'Novus', 'Nature']
  const TYPES = ['Utility', 'Offense', 'Defense', 'Solo']
  const ROLES = ['Town', 'Production', 'Weapon', 'Structure']
  // Island rows from top to bottom; each row is centred on a 19-tile width.
  const ISLAND_ROWS = [11, 13, 15, 17, 19, 19, 19, 19, 19, 19, 19, 19, 17, 15, 13, 11]
  const ISLAND_COLS = 19
  // Build codes put (0, 0) near the middle of the island.
  const ISLAND_OFFSET = 8

  // SkyShard-Public exports every resource as a list of {var, value} properties.
  const props = resource => Object.fromEntries(resource.map(p => [p.var, p.value]))

  function flattenUnits (raw) {
    return raw.map(props).map(u => ({
      id: u.ID,
      name: u.Name,
      info: u.Info || '',
      inShop: !!u.InShop,
      conditional: u.Conditional || [],
      rarity: u.Rarity,
      faction: u.Faction,
      type: u.Type,
      role: u.Role,
      w: u.length_x,
      h: u.length_y,
      health: u.Health,
      damage: u.HasDamage ? u.Damage : 0,
      synergy: (u.SynergyUnits || []).filter(id => id >= 0)
    }))
  }

  // Only shops that sell units ("What" = Unit) and can still appear.
  function flattenShops (raw) {
    return raw.map(props)
      .filter(e => e.What === 1 && e.InShop)
      .map(e => ({
        id: e.ID,
        name: e.Name,
        info: e.Info || '',
        cost: e.Cost,
        tiers: (String(e.TierInfo || '').match(/\d+/g) || []).map(Number),
        // Encounter enums are the unit enums shifted by one, with 0 meaning "any".
        faction: e.Faction - 1,
        type: e.Type - 1,
        role: e.Role - 1,
        offers: [0, 1, 3, 6][e.Specific] || 1
      }))
  }

  function indexUnits (units) {
    return new Map(units.map(u => [u.id, u]))
  }

  // Build code -> Int32 words. Takes the gunzipped bytes as a Uint8Array/Buffer.
  function wordsFromBytes (bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const words = new Int32Array(bytes.byteLength >> 2)
    for (let i = 0; i < words.length; i++) words[i] = view.getInt32(i * 4, true)
    return words
  }

  // Layout (from the SkyShard Ranked Tracker): [header, 6n, x*n, y*n, id*n, ench0*n, ench1*n, ench2*n]
  function boardFromWords (words) {
    const n = words[1] / 6
    const b = words.subarray(2)
    const board = []
    for (let i = 0; i < n; i++) {
      board.push({
        x: b[i],
        y: b[n + i],
        id: b[2 * n + i],
        enchants: [b[3 * n + i], b[4 * n + i], b[5 * n + i]].filter(e => e > 0)
      })
    }
    return board
  }

  // Pulls the latest player and opponent build codes out of godot.log.
  function parseLog (text) {
    const lines = text.split(/\r?\n/)
    let build = null
    let buildLine = -1
    let opponent = null
    let builds = 0
    // Each run starts over at round 1; runKey is the first build of the latest run, so the app can
    // tell a run it has already moved on from (the log can lag a whole run behind the screen).
    let runKey = null
    let lastRound = 0
    let pendingRound = false
    lines.forEach((line, i) => {
      let m = line.match(/^Current build: (\S+)/)
      if (m) {
        build = m[1]
        buildLine = i
        builds++
        opponent = null
        if (!runKey) runKey = build
        pendingRound = true
        return
      }
      m = line.match(/GET DIR (\d+)_/)
      if (m && pendingRound) {
        const r = Number(m[1])
        if (r < lastRound) runKey = build
        lastRound = r
        pendingRound = false
        return
      }
      m = line.match(/^Opponent Board: (\S+)/)
      if (m) opponent = m[1]
    })
    // The game fetches "<round>_Ranked..." right after saving a round's build.
    let round = null
    let mode = null
    if (buildLine >= 0) {
      for (let i = buildLine + 1; i < lines.length; i++) {
        const m = lines[i].match(/GET DIR (\d+)_(\w+)/)
        if (m) { round = Number(m[1]); mode = m[2].replace(/_/g, ' '); break }
        if (lines[i].startsWith('Current build:')) break
      }
    }
    return { build, opponent, builds, round, mode, runKey }
  }

  function summarize (board, byId) {
    const count = (labels, key) => labels.map((label, i) => ({
      label,
      n: board.filter(p => byId.get(p.id) && byId.get(p.id)[key] === i).length
    })).filter(c => c.n > 0)
    return {
      units: board.length,
      mana: board.reduce((sum, p) => sum + ((byId.get(p.id) || {}).rarity || 0), 0),
      factions: count(FACTIONS, 'faction'),
      types: count(TYPES, 'type'),
      roles: count(ROLES, 'role')
    }
  }

  // How many copies of each unit id are owned.
  function ownedCounts (ids) {
    const owned = new Map()
    for (const id of ids) owned.set(id, (owned.get(id) || 0) + 1)
    return owned
  }

  // Conditional units only show up in shops once one of the listed units is owned.
  const unlocked = (unit, owned) => !unit.conditional.length || unit.conditional.some(id => owned.has(id))

  // Scores every buyable unit by the game's synergy lists, counted both ways:
  // an owned unit listing the candidate, and the candidate listing an owned unit.
  function recommend (owned, units, byId) {
    const recs = []
    for (const c of units) {
      if (!c.inShop || !unlocked(c, owned)) continue
      const reasons = []
      for (const id of owned.keys()) {
        const o = byId.get(id)
        if (!o) continue
        const pull = o.synergy.includes(c.id) + c.synergy.includes(o.id)
        if (pull) reasons.push({ id, name: o.name, weight: pull })
      }
      if (!reasons.length) continue
      reasons.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
      recs.push({
        unit: c,
        score: reasons.reduce((s, r) => s + r.weight, 0),
        reasons,
        owned: owned.get(c.id) || 0
      })
    }
    return recs.sort((a, b) => b.score - a.score || a.unit.rarity - b.unit.rarity || a.unit.name.localeCompare(b.unit.name))
  }

  // Units that need another unit first, and that requirement is now met.
  function unlocks (owned, units) {
    return units.filter(u => u.inShop && u.conditional.length && unlocked(u, owned) && !owned.has(u.id))
  }

  // Units a shop can roll. Units at the shop's top tier are twice as likely as
  // the tier below (patch 0.11.x notes).
  function shopPool (shop, units, owned) {
    const top = Math.max(...shop.tiers)
    return units
      .filter(u => u.inShop && shop.tiers.includes(u.rarity) && unlocked(u, owned) &&
        (shop.faction < 0 || u.faction === shop.faction) &&
        (shop.type < 0 || u.type === shop.type) &&
        (shop.role < 0 || u.role === shop.role))
      .map(u => ({ unit: u, weight: shop.tiers.length > 1 && u.rarity === top ? 2 : 1 }))
  }

  // The suggestions worth chasing: the top `topN` by score, plus anything tied with the last one.
  function topPicks (recs, topN = 15) {
    if (!recs.length) return []
    const cutoff = recs[Math.min(topN, recs.length) - 1].score
    return recs.filter(r => r.score >= cutoff)
  }

  // Ranks shops by the chance that at least one offered unit is a top pick.
  // On a big board nearly every unit has some synergy, so "any fit" would be 100% everywhere.
  function scoreShops (shops, units, owned, recs, topN = 15) {
    const picks = topPicks(recs, topN)
    const pickScore = new Map(picks.map(r => [r.unit.id, r.score]))
    return shops.map(shop => {
      const pool = shopPool(shop, units, owned)
      const total = pool.reduce((s, p) => s + p.weight, 0)
      const fits = pool.filter(p => pickScore.has(p.unit.id))
      const fitWeight = fits.reduce((s, p) => s + p.weight, 0)
      const p = total ? fitWeight / total : 0
      return {
        shop,
        poolSize: pool.length,
        fits: fits.map(f => f.unit).sort((a, b) => pickScore.get(b.id) - pickScore.get(a.id)),
        chance: 1 - Math.pow(1 - p, Math.min(shop.offers, pool.length || 1))
      }
    }).filter(s => s.poolSize > 0)
      .sort((a, b) => b.chance - a.chance || b.fits.length - a.fits.length || a.shop.cost - b.shop.cost)
  }

  // How many of a unit one purchase gives: units like Tree and Vinculi say "When you buy a Tree, get a copy."
  function copiesPerBuy (unit) {
    return unit && /when you buy an? [^.]*get a copy/i.test(unit.info || '') ? 2 : 1
  }

  // Tiles a unit covers. Board positions are the unit's bottom-left tile; it reaches w right and h up.
  function footprint (x, y, w, h) {
    const tiles = []
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) tiles.push(`${x + i},${y - j}`)
    return tiles
  }

  function onIsland (key) {
    const [x, y] = key.split(',').map(Number)
    const r = y + ISLAND_OFFSET
    if (r < 0 || r >= ISLAND_ROWS.length) return false
    const start = (ISLAND_COLS - ISLAND_ROWS[r]) / 2 - ISLAND_OFFSET
    return x >= start && x < start + ISLAND_ROWS[r]
  }

  // ---------- The island as the app believes it ----------
  // A roster is [{ key, id, x, y, how, at }]: how = 'log' (from the game's log), 'seen' (read off the
  // screen) or 'manual' (put there by the player); at = when it was added. Units in the inventory
  // don't count: a unit is owned while it stands on the island.

  const pieceKey = (id, x, y) => `${id}@${x},${y}`
  function piece (id, x, y, how, at) {
    return { key: pieceKey(id, x, y), id, x, y, how, at }
  }
  function tilesOf (p, byId) {
    const u = byId.get(p.id) || { w: 1, h: 1 }
    return footprint(p.x, p.y, u.w, u.h)
  }
  function overlapping (roster, keys, byId) {
    const want = new Set(keys)
    return roster.filter(p => tilesOf(p, byId).some(k => want.has(k)))
  }

  // Adds the log's board: each unit whose tiles nobody holds yet. The screen is newer than the log,
  // so where the two disagree the roster wins; a log unit that's gone is dropped on the next reading.
  // Two exceptions: a unit already on the roster at the log's spot is marked as confirmed (inLog), and a
  // unit read off the screen at exactly the log's spot under another name (same size) was misread, so
  // the log's unit takes its place.
  const WEAK_SIGHTING = 0.75
  function mergeLog (roster, build, byId, at = 0) {
    const size = id => { const u = byId.get(id) || { w: 1, h: 1 }; return `${u.w}x${u.h}` }
    const inBuild = new Set((build || []).map(b => pieceKey(b.id, b.x, b.y)))
    let next = roster.map(p => !!p.inLog === inBuild.has(p.key) ? p : { ...p, inLog: inBuild.has(p.key) })
    for (const b of build || []) {
      if (next.some(p => p.key === pieceKey(b.id, b.x, b.y))) continue
      const inWay = overlapping(next, tilesOf(b, byId), byId)
      // A unit read from the screen where the board has another of the same size is a misread, and so is a
      // weakly sighted smaller one standing wholly on the board unit's tiles that the board doesn't list
      // (a Shrub at 0.66 read off a corner of the Mecha Dragon). A clear one may be a swap since the board.
      const tiles = new Set(tilesOf(b, byId))
      const area = id => { const u = byId.get(id) || { w: 1, h: 1 }; return u.w * u.h }
      // The same unit a tile off the board's spot (and not listed there) was read a tile off: a wide flat
      // Powerline fit almost as well one tile over (0.50 against 0.82), and its tiles then looked taken.
      const shifted = p => p.id === b.id && !inBuild.has(p.key) && Math.abs(p.x - b.x) <= 1 && Math.abs(p.y - b.y) <= 1 &&
        !(p.how === 'manual' && !p.seen)
      const misread = p => shifted(p) || (p.how === 'seen' && ((p.x === b.x && p.y === b.y && size(p.id) === size(b.id)) ||
        (!inBuild.has(p.key) && p.score < WEAK_SIGHTING && area(p.id) < area(b.id) && tilesOf(p, byId).every(k => tiles.has(k)))))
      if (!inWay.every(misread)) continue
      next = next.filter(p => !inWay.includes(p))
      next.push({ ...piece(b.id, b.x, b.y, 'log', at), inLog: true })
    }
    return next
  }

  // Puts a unit somewhere by hand; whatever stood on those tiles is taken off. Returns { roster, removed }.
  function placePiece (roster, id, x, y, byId, at = 0) {
    const removed = overlapping(roster, footprint(x, y, (byId.get(id) || { w: 1 }).w, (byId.get(id) || { h: 1 }).h), byId)
    const next = roster.filter(p => !removed.includes(p)).concat(piece(id, x, y, 'manual', at))
    return { roster: next, removed }
  }

  // Folds one reading of the island (from the vision worker) into the roster. Returns
  // { roster, removed, added }. reading: { view, grid, stats, covered, ground, verified, sightings }.
  //  - A unit is taken off when the grid shows half its tiles empty, or (no grid) half its tiles are
  //    bare ground and its picture no longer matches. Tiles hidden by a panel prove nothing, and
  //    while Island Stats is open (enchantments drawn over units) only the grid counts.
  //  - A sighting is added where nothing stands; it replaces units that no longer match their picture,
  //    and a very clear one (0.8+) replaces a unit that matches poorly.
  //  - A unit that has matched its spot clearly (`sure`) at some point, and then plainly doesn't (below
  //    `lost`) on `misses` readings in a row, is taken off too: for spots that never look bare (the
  //    island's edge, under a tall neighbour's overhang). Units never seen clearly (hidden behind others
  //    from the start) are left alone, unless the same kind of unit has turned up elsewhere since and
  //    `bought` (this round's purchases) doesn't account for it.
  //  - owned: Map unit id -> copies the last board and this round's purchases account for (when the log
  //    has a board); a sighting beyond that takes a worse-matching copy off its old spot (it was moved).
  function trackIsland (roster, reading, byId, at = 0, { gone = 0.45, replace = 0.35, strong = 0.8, weak = 0.5, lost = 0.3, misses = 3, sure = 0.6, bought = [], owned = null } = {}) {
    // A unit's card up (view 'card'): the hovered unit and its partners are tinted, so only units that are
    // plainly gone are taken off; nothing is added and no misses are counted.
    const cardUp = !!reading && reading.view === 'card' && !!reading.verified
    if (!reading || (reading.view !== 'ok' && !cardUp)) return { roster, removed: [], added: [] }
    const hidden = new Set(reading.covered || [])
    const ground = new Set(reading.ground || [])
    const grid = reading.grid || null
    const score = new Map((reading.verified || []).map(v => [v.key, v.score]))
    const has = k => onIsland(k)
    const removed = []
    // A unit placed by hand that the app has never matched clearly (the reason it was placed by hand) is
    // left to the player: its picture never fits, so a poor match there means nothing. Once it has been
    // seen clearly, it's treated like any other unit.
    const trusted = p => p.how === 'manual' && !p.seen
    const movedAway = p => {
      if (trusted(p)) return false
      const later = roster.filter(q => q !== p && q.id === p.id && q.how !== 'log' && q.at > p.at).length
      return later > bought.filter(id => id === p.id).length
    }
    let next = roster.map(p => {
      const tiles = tilesOf(p, byId).filter(has)
      if (!tiles.length || tiles.some(k => hidden.has(k))) return p
      const half = tiles.length / 2
      const v = score.get(p.key)
      const empty = grid ? tiles.filter(k => grid[k] === '.').length >= half
        : !reading.stats && tiles.filter(k => ground.has(k)).length >= half && (v ?? 0) < gone
      // Counts readings in a row where the picture is plainly gone (Island Stats can hide it, so not then).
      // Added by a clear sighting, or the same kind of unit turned up somewhere else since (and no
      // purchase explains it): a picture that's plainly gone here then means it was moved.
      const seen = p.seen || p.how === 'seen' || (v !== undefined && !reading.stats && v >= sure) || movedAway(p)
      const missed = !seen || v === undefined || reading.stats || trusted(p) ? (p.missed || 0) : v < lost ? (p.missed || 0) + 1 : 0
      if (cardUp) { if (empty) { removed.push(p); return null } return p }
      if (empty || missed >= misses) { removed.push(p); return null }
      return missed === (p.missed || 0) && seen === !!p.seen ? p : { ...p, missed, seen }
    }).filter(Boolean)
    const added = []
    for (const s of cardUp ? [] : reading.sightings || []) {
      const tiles = footprint(s.x, s.y, (byId.get(s.id) || { w: 1 }).w, (byId.get(s.id) || { h: 1 }).h)
      if (!tiles.every(has) || (grid && tiles.some(k => grid[k] === '.'))) continue
      const inWay = overlapping(next, tiles, byId)
      if (inWay.some(p => p.id === s.id && p.x === s.x && p.y === s.y)) continue
      // Island Stats draws enchantments over units, so a poor match then doesn't mean a unit left.
      if (reading.stats && inWay.length) continue
      const poor = p => (score.get(p.key) ?? 0) < replace || (s.score >= strong && (score.get(p.key) ?? 0) < weak)
      // A unit placed by hand and never matched clearly only gives way when its picture is plainly not
      // there. Every other unit (the log's too) gives way the same: the player moves and sells units.
      const yields = p => trusted(p) ? score.has(p.key) && score.get(p.key) < lost : poor(p)
      if (inWay.some(p => !yields(p))) continue
      removed.push(...inWay)
      next = next.filter(p => !inWay.includes(p))
      const q = { ...piece(s.id, s.x, s.y, 'seen', at), score: s.score }
      // Moved: the same kind of unit, now standing mostly on bare tiles and matching worse than the
      // new sighting, is the one that was picked up (a wide unit shifted by a row still half-matches).
      const left = next.filter(p => {
        // Only units checked on this reading: two copies seen together aren't one that moved.
        if (p.id !== s.id || trusted(p) || !score.has(p.key)) return false
        const own = tilesOf(p, byId).filter(has)
        if (!own.length || own.some(k => hidden.has(k))) return false
        const bare = own.filter(k => grid ? grid[k] === '.' : ground.has(k)).length
        const v = score.get(p.key) ?? 0
        return (bare >= own.length / 2 || v < 0.3) && v < s.score - 0.1
      })
      // Moved, too: more copies of the unit than the last board and this round's purchases account for,
      // so the copy matching clearly worse is the one that was picked up (moved somewhere else and another
      // unit put in its place, so its spot doesn't look bare).
      if (owned && owned.has(s.id)) {
        const copies = next.filter(p => p.id === s.id && !left.includes(p))
        const extra = copies.length + 1 - owned.get(s.id)
        const stale = copies.filter(p => !trusted(p) && score.has(p.key) && score.get(p.key) < Math.min(0.6, s.score - 0.15))
          .sort((a, b) => score.get(a.key) - score.get(b.key)).slice(0, Math.max(0, extra))
        left.push(...stale)
      }
      removed.push(...left)
      next = next.filter(p => !left.includes(p))
      next.push(q)
      added.push(q)
    }
    return { roster: next, removed, added }
  }

  // A unit's card was up in the game with the mouse on the unit at spot { id, x, y }: the unit at that
  // spot is named for sure. One already there is marked as checked; otherwise it's put there like a
  // unit placed by hand. Returns { roster, removed }.
  // reading: the last reading of the island. With it, a unit that was moved is taken off its old spot:
  // the copy of the same unit that was seen clearly before and now plainly isn't there (or stands on
  // bare ground). Copies never seen clearly (hidden behind others) are left alone.
  function nameFromCard (roster, spot, byId, at = 0, { reading = null, lost = 0.3 } = {}) {
    const key = pieceKey(spot.id, spot.x, spot.y)
    const placed = roster.some(p => p.key === key) ? { roster, removed: [] } : placePiece(roster, spot.id, spot.x, spot.y, byId, at)
    let next = placed.roster.map(p => p.key === key && !(p.card && p.seen) ? { ...p, card: true, seen: true } : p)
    const removed = [...placed.removed]
    if (reading && reading.view === 'ok') {
      const score = new Map((reading.verified || []).map(v => [v.key, v.score]))
      const ground = new Set(reading.ground || [])
      const hidden = new Set(reading.covered || [])
      const left = next.filter(p => {
        if (p.key === key || p.id !== spot.id || (p.how === 'manual' && !p.card && !p.seen) || !score.has(p.key)) return false
        const tiles = tilesOf(p, byId).filter(onIsland)
        if (!tiles.length || tiles.some(k => hidden.has(k))) return false
        const bare = tiles.filter(k => ground.has(k)).length >= tiles.length / 2
        return bare || (p.seen && score.get(p.key) < lost)
      }).sort((a, b) => score.get(a.key) - score.get(b.key)).slice(0, 1)
      removed.push(...left)
      next = next.filter(p => !left.includes(p))
    }
    return { roster: next, removed }
  }

  // The unit whose name text read off the screen spells, allowing a few misread letters; null when
  // none is close enough or two are equally close.
  function matchName (text, units) {
    const norm = s => String(s).toLowerCase().replace(/[^a-z]/g, '')
    const t = norm(text)
    if (t.length < 3) return null
    const distance = (a, b) => {
      let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
      for (let i = 1; i <= a.length; i++) {
        const row = [i]
        for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = row
      }
      return prev[b.length]
    }
    const scored = units.map(u => {
      const name = norm(u.name)
      // The reading can run on past the name (the card's border, a second line): its start counts too.
      let d = distance(t, name)
      for (let n = Math.max(3, name.length - 1); n <= Math.min(t.length - 1, name.length + 1); n++) d = Math.min(d, distance(t.slice(0, n), name))
      return { u, d, len: name.length }
    })
    // Closest first; between equally close names the longer one ("Tree Fort" over "Tree").
    scored.sort((a, b) => a.d - b.d || b.len - a.len)
    const [first, next] = scored
    if (!first || (next && next.d === first.d && next.len === first.len)) return null
    const best = first.u
    const bestD = first.d
    return bestD <= Math.max(1, Math.floor(norm(best.name).length / 5)) ? best : null
  }

  // Bought units that haven't shown up on the island since they were bought (each new unit of the
  // same kind added since `since` uses one up).
  function unplacedBought (roster, bought, since = 0) {
    const left = [...bought]
    for (const p of roster) {
      if (p.how === 'log' || p.at < since) continue
      const i = left.indexOf(p.id)
      if (i >= 0) left.splice(i, 1)
    }
    return left
  }

  // Spots on the island where the reader saw something it couldn't name for sure (a unit it lost track
  // of nearly fits there): [{ x, y, w, h, guesses: [{ id, x, y, score }], at }]. A spot stays until the
  // player names it, a unit is put on its tiles, or its tiles look bare. reading as for trackIsland.
  function trackUnsure (spots, reading, roster, byId, now) {
    const tilesOf = s => footprint(s.x, s.y, s.w, s.h)
    let out = spots
    if (reading && reading.view === 'ok') {
      const grid = reading.grid
      const ground = new Set(reading.ground || [])
      const bare = k => grid ? grid[k] === '.' : ground.has(k)
      const fresh = (reading.unsure || []).map(s => ({ ...s, at: now }))
      const freshTiles = new Set(fresh.flatMap(tilesOf))
      out = [...out.filter(s => !tilesOf(s).some(k => freshTiles.has(k)) && !tilesOf(s).every(bare)), ...fresh]
    }
    const taken = new Set(roster.flatMap(p => {
      const u = byId.get(p.id)
      return u ? footprint(p.x, p.y, u.w, u.h) : []
    }))
    return out.filter(s => !tilesOf(s).some(k => taken.has(k)))
  }

  return {
    FACTIONS, TYPES, ROLES, ISLAND_ROWS, ISLAND_COLS, ISLAND_OFFSET,
    flattenUnits, flattenShops, indexUnits, wordsFromBytes, boardFromWords, parseLog,
    summarize, copiesPerBuy, ownedCounts, recommend, unlocks, shopPool, topPicks, scoreShops, footprint, onIsland, pieceKey, mergeLog, placePiece, nameFromCard, matchName, trackIsland, trackUnsure, unplacedBought
  }
})
