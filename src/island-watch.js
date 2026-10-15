// Reads the player's island from frames of the game, with or without the grid showing.
// Keeps what it needs between frames (where the camera was, how each tile looked) and reports
// what it can tell about the units the app thinks are there. Used by the vision worker.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vision'))
  else root.IslandWatch = factory(root.SkyVision)
})(typeof self !== 'undefined' ? self : this, function (vision) {
  // A frame counts as the usual view when its scenery matches the last confirmed view this well.
  const SAME_VIEW = 0.8
  // How much a tile's mean colour has to move to count as changed (still frames differ by 0-3).
  const CHANGED = 40
  // Most tiles tried for new units in one go, so a frame never takes long.
  const MAX_TRIES = 48
  // A tile that looks the same is searched again after this many reads anyway: a unit dropped where it
  // was being dragged looks the same before and after, so the change alone can miss it.
  const RETRY = 30
  // A one-tile unit seen right beside a settled unit needs at least this score (see read).
  const WEAK_BESIDE = 0.75
  // A big rearrange: this many tiles changing look within the last CHURN_READS reads. While it lasts,
  // every open tile is searched again every few reads, not only once it looks different: after many
  // drops a tile can end up looking much as it did when it was last searched, with another unit on it.
  const REARRANGE = 30
  const CHURN_READS = 120
  const REARRANGE_RETRY = 3
  // Share of tiles that must look like bare ground to take a frame as the home view with no other sign.
  const BARE_START = 0.8

  function bareShare (frame) {
    const looks = vision.tileLooks(frame)
    const keys = Object.keys(looks)
    return keys.filter(k => vision.groundLike(looks[k])).length / keys.length
  }

  function createWatcher (templates, units) {
    let view = null // camera sample of the confirmed usual view
    let tried = {} // tile -> { look, n }: how it looked, and the read it was last searched on
    let reads = 0
    // Sightings from the last read, not reported yet: a new unit only counts once two reads in a row
    // see it, so a passing cloud or a half-drawn frame can't add one.
    let pending = new Set()
    let lastLooks = null // tile looks on the last read without the grid
    let churn = [] // { n, changed }: tiles that changed look, per read

    function reset () {
      view = null
      tried = {}
      pending = new Set()
      lastLooks = null
      churn = []
    }

    // frame: BGRA 1280x720. pieces: [{ key, id, x, y }] the app thinks are on the island.
    // hints: unit ids bought this round. missing: unit ids the app lost track of lately (likely moved):
    // they're looked for with a lower bar, and every open tile is searched again every few reads. Returns
    // { view: 'ok'|'moved'|'unknown', grid, stats, covered, ground, verified, sightings }.
    // hi: the island at full size, when the game runs above 1280x720 (see vision.sharpScore).
    // With a card up, only what's needed to take off units that are plainly gone (see read).
    function cardReading (frame, pieces, hi) {
      const grid = vision.islandTiles(frame)
      if (!view || (!grid && vision.cameraMatch(view, vision.cameraSample(frame)) < SAME_VIEW)) return { view: 'card' }
      const covered = vision.coveredTiles(frame)
      const hidden = new Set(covered)
      const looks = grid ? null : vision.tileLooks(frame)
      const ground = looks ? Object.keys(looks).filter(k => !hidden.has(k) && vision.groundLike(looks[k])) : []
      return { view: 'card', grid, stats: vision.statsOpen(frame), covered, ground, verified: vision.verifyOnIsland(frame, templates, units, pieces, hi), sightings: [] }
    }

    function read (frame, { pieces = [], hints = [], missing = [], hi = null } = {}) {
      // A unit's card is up: the game tints the units its ability affects, so they don't look like
      // themselves (capture.js holds island reads back while it sees a card; this catches the rest).
      // Still, a unit that's plainly gone (bare ground, picture gone) can be taken off meanwhile: the player
      // can sell units while reading cards in a shop for a minute (a sold Portal stayed that long).
      if (vision.unitCard(frame)) return cardReading(frame, pieces, hi)
      const grid = vision.islandTiles(frame)
      const sample = vision.cameraSample(frame)
      // The grid only lines up with the usual view, so seeing it confirms where the camera is.
      if (grid) view = sample
      if (!view) {
        // No grid yet this run: the units the app knows about standing where expected confirms it too.
        const check = vision.verifyOnIsland(frame, templates, units, pieces)
        // Either most of them, or two that match clearly (the list may hold a unit that isn't there).
        const good = check.filter(v => v.score >= 0.5).length
        const clear = check.filter(v => v.score >= 0.7).length
        // Or, early in a run when the app knows of few units: an island of mostly bare ground where the
        // home island stands (a fight's view leaves about half the tiles bare, a built-up island less).
        if (clear < 2 && (pieces.length < 3 || good < pieces.length / 2) && !(pieces.length < 3 && bareShare(frame) >= BARE_START)) return { view: 'unknown' }
        view = sample
      } else if (!grid && vision.cameraMatch(view, sample) < SAME_VIEW) {
        return { view: 'moved' }
      }
      const stats = vision.statsOpen(frame)
      const covered = vision.coveredTiles(frame)
      const hidden = new Set(covered)
      const result = { view: 'ok', grid, stats, covered, ground: [], verified: [], sightings: [] }
      const verified = vision.verifyOnIsland(frame, templates, units, pieces, hi)
      result.verified = verified
      const looks = grid ? null : vision.tileLooks(frame)
      if (looks) result.ground = Object.keys(looks).filter(k => !hidden.has(k) && vision.groundLike(looks[k]))
      // Tiles held by a unit that still looks like itself are settled; anything else that isn't bare
      // (or with the grid: is marked taken) may hold something new.
      const settled = new Set()
      const score = new Map(verified.map(v => [v.key, v.score]))
      const ground = new Set(result.ground)
      for (const p of pieces) {
        const u = units.get(p.id)
        if (!u || (score.get(p.key) || 0) < 0.45) continue
        const own = []
        for (let i = 0; i < u.w; i++) for (let j = 0; j < u.h; j++) own.push(`${p.x + i},${p.y - j}`)
        // A unit standing mostly on bare tiles has likely moved, whatever its picture says; its tiles stay open.
        const bare = own.filter(k => grid ? grid[k] === '.' : ground.has(k)).length
        if (bare >= own.length / 2) continue
        for (const k of own) settled.add(k)
      }
      let open = vision.ISLAND_TILES.map(t => t.key).filter(k => !settled.has(k) && !hidden.has(k) &&
        (grid ? grid[k] !== '.' : !ground.has(k)))
      // Without the grid, a tile is only searched again once it looks different from the last search.
      reads++
      if (looks) {
        // (Against the last read without the grid, so a drag counts once it's dropped.)
        if (lastLooks) churn.push({ n: reads, changed: Object.keys(looks).filter(k => !hidden.has(k) && lastLooks[k] && vision.lookChange(lastLooks[k], looks[k]) > CHANGED).length })
        lastLooks = looks
      }
      churn = churn.filter(c => reads - c.n < CHURN_READS)
      const rearranging = churn.reduce((n, c) => n + c.changed, 0) >= REARRANGE
      result.rearranging = rearranging
      const retry = rearranging || missing.length ? REARRANGE_RETRY : RETRY
      if (looks) open = open.filter(k => !tried[k] || reads - tried[k].n >= retry || vision.lookChange(tried[k].look, looks[k]) > CHANGED)
      // The oldest searches first, so a long list of tiles takes turns.
      if (looks) open.sort((a, b) => (tried[a] ? tried[a].n : -1) - (tried[b] ? tried[b].n : -1))
      open = open.slice(0, MAX_TRIES)
      if (open.length) {
        // A unit stands on every tile of its footprint, so none of them can be bare.
        const blocked = [...settled, ...hidden, ...(grid ? Object.keys(grid).filter(k => grid[k] === '.') : ground)]
        // A weak match for a one-tile unit right beside a unit already standing there is usually a piece
        // of that unit's picture (the Soul Engine's leg read as a Shrub), unless it was just bought.
        const beside = s => [-1, 0, 1].some(dx => [-1, 0, 1].some(dy => (dx || dy) && settled.has(`${s.x + dx},${s.y + dy}`)))
        const seen = vision.identifyOnIsland(frame, templates, units, open, { blocked, hints, missing, hi })
          .filter(s => !(units.get(s.id).w * units.get(s.id).h === 1 && s.score < WEAK_BESIDE && !hints.includes(s.id) && beside(s)))
        const key = s => `${s.id}@${s.x},${s.y}`
        result.sightings = seen.filter(s => pending.has(key(s)))
        pending = new Set(seen.filter(s => !pending.has(key(s))).map(key))
        result.pending = pending.size
        // Tiles under a sighting still to be confirmed are searched again next time.
        const recheck = new Set(seen.filter(s => pending.has(key(s))).flatMap(s => {
          const u = units.get(s.id)
          const out = []
          for (let i = 0; i < u.w; i++) for (let j = 0; j < u.h; j++) out.push(`${s.x + i},${s.y - j}`)
          return out
        }))
        if (looks) for (const k of open) if (!recheck.has(k)) tried[k] = { look: looks[k], n: reads }
      } else {
        pending = new Set()
      }
      return result
    }

    return { read, reset }
  }

  return { createWatcher }
})
