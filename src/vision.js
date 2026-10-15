// Reads the units in an open shop from a screenshot of the game.
// Works on frames scaled to 1280x720, BGRA bytes (what Electron's desktopCapturer gives on Windows).
// Units are matched against art from the in-game library with masked normalized correlation,
// the same measure as OpenCV's TM_CCOEFF_NORMED with a mask.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.SkyVision = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const FRAME_W = 1280
  const FRAME_H = 720
  // On-screen size of one island tile at 1280x720. A unit's longest side is about TILE x its longest footprint side.
  const TILE = 26
  // The centre of each shop spot for the three shop sizes. Each unit's picture is centred on its spot,
  // so tall units reach up and wide ones reach sideways (measured from real shops).
  const COLS = [795, 925, 1055]
  const LAYOUTS = {
    6: [292, 382].flatMap(y => COLS.map(x => ({ x, y }))),
    3: COLS.map(x => ({ x, y: 338 })),
    1: [{ x: 925, y: 338 }]
  }
  // Grass on the shop island, spread out so a wide unit can only cover a few. Picked from 33 shop
  // frames (8-9 of these show grass in each) and 31 frames without a shop (none do).
  const GROUND_POINTS = [[940, 240], [1020, 260], [1090, 300], [970, 310], [1130, 360], [1010, 370], [1070, 410], [930, 420], [800, 280]]
  // The rock under the shop island.
  const ROCK_POINTS = [[925, 560], [800, 520], [1050, 520]]
  const MATCH = 0.7 // sure enough to name a unit without asking
  const LAYOUT_MATCH = 0.62 // every slot of a layout holds some unit
  const CLOSE_CALL = 0.04 // top two this close: ask the player

  // Area-average resize of a BGRA image (like OpenCV's INTER_AREA when shrinking).
  function resize (src, sw, sh, dw, dh) {
    const weights = (sn, dn) => {
      const scale = sn / dn
      const out = []
      for (let d = 0; d < dn; d++) {
        const a = d * scale
        const b = a + scale
        const taps = []
        for (let s = Math.floor(a); s < Math.min(sn, Math.ceil(b)); s++) {
          const w = Math.min(b, s + 1) - Math.max(a, s)
          if (w > 1e-6) taps.push([s, w / scale])
        }
        out.push(taps)
      }
      return out
    }
    const wx = weights(sw, dw)
    const wy = weights(sh, dh)
    const tmp = new Float32Array(dw * sh * 4)
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < dw; x++) {
        const o = (y * dw + x) * 4
        for (const [s, w] of wx[x]) {
          const i = (y * sw + s) * 4
          tmp[o] += src[i] * w; tmp[o + 1] += src[i + 1] * w; tmp[o + 2] += src[i + 2] * w; tmp[o + 3] += src[i + 3] * w
        }
      }
    }
    const out = new Uint8ClampedArray(dw * dh * 4)
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const o = (y * dw + x) * 4
        let b = 0, g = 0, r = 0, a = 0
        for (const [s, w] of wy[y]) {
          const i = (s * dw + x) * 4
          b += tmp[i] * w; g += tmp[i + 1] * w; r += tmp[i + 2] * w; a += tmp[i + 3] * w
        }
        out[o] = b; out[o + 1] = g; out[o + 2] = r; out[o + 3] = a
      }
    }
    return out
  }

  // A frame and its half-size copy, used to shortlist quickly.
  function pyramid (frame) {
    if (frame.width !== FRAME_W || frame.height !== FRAME_H) {
      frame = { width: FRAME_W, height: FRAME_H, data: resize(frame.data, frame.width, frame.height, FRAME_W, FRAME_H) }
    }
    const half = { width: FRAME_W / 2, height: FRAME_H / 2, data: resize(frame.data, FRAME_W, FRAME_H, FRAME_W / 2, FRAME_H / 2) }
    return [frame, half]
  }

  // Template scaled for one pyramid level, with the parchment masked out.
  function prepare (tpl, factor, stride) {
    const w = Math.max(3, Math.round(tpl.w * factor))
    const h = Math.max(3, Math.round(tpl.h * factor))
    const px = resize(tpl.data, tpl.w, tpl.h, w, h)
    const offs = []
    const vals = []
    // The drawn part's own box (a flat unit like the Solaris Saber fills a fraction of its picture).
    let x0 = w, x1 = -1, y0 = h, y1 = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (px[i + 3] < 128) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        offs.push((y * stride + x) * 4)
        vals.push(px[i], px[i + 1], px[i + 2])
      }
    }
    const n = offs.length
    const mean = [0, 0, 0]
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += vals[i * 3 + c] / n
    const t = new Float32Array(n * 3)
    let norm = 0
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        t[i * 3 + c] = vals[i * 3 + c] - mean[c]
        norm += t[i * 3 + c] ** 2
      }
    }
    return { w, h, n, offs: Int32Array.from(offs), t, norm, mean, drawn: { w: Math.max(1, x1 - x0 + 1), h: Math.max(1, y1 - y0 + 1), y0: Math.max(0, y0), y1: Math.max(0, y1) } }
  }

  // Sizes tried around the expected one; the middle one (k = 1) is also used for the quick pass.
  const SCALES = [0.88, 0.94, 1, 1.06, 1.12]
  // Most a sighting's mean colour may differ from its picture's (see colourGap).
  const COLOUR_GAP = 72
  const MID = SCALES.indexOf(1)

  // Left-right mirror image of a BGRA picture.
  function mirror (tpl) {
    const out = new Uint8Array(tpl.w * tpl.h * 4)
    for (let y = 0; y < tpl.h; y++) {
      for (let x = 0; x < tpl.w; x++) {
        const i = (y * tpl.w + x) * 4
        const j = (y * tpl.w + (tpl.w - 1 - x)) * 4
        out[j] = tpl.data[i]; out[j + 1] = tpl.data[i + 1]; out[j + 2] = tpl.data[i + 2]; out[j + 3] = tpl.data[i + 3]
      }
    }
    return { w: tpl.w, h: tpl.h, data: out }
  }

  // Loads templates from the library art. raw = { index: [{id, w, h, offset, box?, source?}], bytes }.
  // `units` gives each unit's footprint, which fixes its size on screen. A unit can have more than one
  // picture (source 'game': cut from a screenshot of the island, for units the library draws differently).
  function loadTemplates (raw, units) {
    const byId = new Map(units.map(u => [u.id, u]))
    const out = new Map()
    for (const e of raw.index) {
      const u = byId.get(e.id)
      if (!u) continue
      const tpl = { w: e.w, h: e.h, data: raw.bytes.subarray(e.offset, e.offset + e.w * e.h * 4) }
      // box: the picture's size before its background was trimmed off, which sets its scale.
      const base = TILE * Math.max(u.w, u.h) / (e.box || Math.max(e.w, e.h))
      // Units can face either way in the game, so each is also tried mirrored.
      const full = [tpl, mirror(tpl)].flatMap(t => SCALES.map(k => prepare(t, base * k, FRAME_W)))
      // Half size (both ways round), for shortlisting quickly on a half-size frame.
      const half = [tpl, mirror(tpl)].map(t => prepare(t, base / 2, FRAME_W / 2))
      // Library pictures stand on their tiles and reach up; pictures cut from the island are centred.
      for (const p of full) p.lift = e.box ? 0 : lift(u, p)
      for (const p of half) p.lift = e.box ? 0 : lift(u, p, 2)
      const known = out.get(e.id)
      if (known) {
        known.full.push(...full)
        known.half.push(...half)
        known.pics.push({ tpl, base })
      } else {
        out.set(e.id, { id: e.id, inShop: u.inShop, full, half, pics: [{ tpl, base }], sharp: new Map() })
      }
    }
    return out
  }

  function score (img, p, x, y) {
    const d = img.data
    const at = (y * img.width + x) * 4
    let cross = 0, sq = 0, s0 = 0, s1 = 0, s2 = 0
    for (let i = 0, j = 0; i < p.n; i++, j += 3) {
      const k = at + p.offs[i]
      const b = d[k], g = d[k + 1], r = d[k + 2]
      cross += p.t[j] * b + p.t[j + 1] * g + p.t[j + 2] * r
      s0 += b; s1 += g; s2 += r
      sq += b * b + g * g + r * r
    }
    const varI = sq - (s0 * s0 + s1 * s1 + s2 * s2) / p.n
    return varI > 1e-6 && p.norm > 0 ? cross / Math.sqrt(varI * p.norm) : 0
  }

  // Best score of one template with its centre near (bx, by).
  // Best score for picture p centred anywhere within rx, ry of (bx, by). at, if given, receives that centre.
  function bestNear (img, p, bx, by, rx, ry, step = 1, at = null) {
    let best = -1
    for (let cy = by - ry; cy <= by + ry; cy += step) {
      const y = Math.round(cy - p.h / 2)
      if (y < 0 || y + p.h > img.height) continue
      for (let cx = bx - rx; cx <= bx + rx; cx += step) {
        const x = Math.round(cx - p.w / 2)
        if (x < 0 || x + p.w > img.width) continue
        const v = score(img, p, x, y)
        if (v > best) {
          best = v
          if (at) { at.x = cx; at.y = cy }
        }
      }
    }
    return best
  }

  // Ranks the units that could be standing on one shop slot. A quick pass at the expected size
  // (every other pixel) shortlists units, then the shortlist is tried at every size.
  // blob = the size of what's standing there (from the empty island), used to rule out units of the wrong size.
  function readSlot (levels, templates, slot, blob = null, shortlist = 16) {
    const [full, half] = levels
    const quick = []
    for (const t of templates.values()) {
      if (!t.inShop) continue
      const penalty = sizePenalty(t.full[MID], blob)
      if (penalty > 0.3) continue
      // The quick pass runs on the half-size frame (a quarter of the work).
      let v = -1
      const at = { x: slot.x, y: slot.y }
      for (const p of t.half) {
        const where = {}
        const s = bestNear(half, p, slot.x / 2, slot.y / 2, 7, 5, 1, where)
        if (s > v) { v = s; at.x = where.x * 2; at.y = where.y * 2 }
      }
      quick.push({ t, penalty, at, v: v - penalty })
    }
    quick.sort((a, b) => b.v - a.v)
    // Every size, close to where the quick pass found it: every other pixel, then the best spot exactly.
    const fine = (p, at) => {
      const where = {}
      bestNear(full, p, at.x, at.y, 4, 4, 2, where)
      return bestNear(full, p, where.x, where.y, 1, 1, 1)
    }
    return quick.slice(0, shortlist)
      .map(({ t, penalty, at }) => ({ id: t.id, score: Math.max(...t.full.map(p => fine(p, at))) - penalty }))
      .sort((a, b) => b.score - a.score)
  }

  // A unit's picture usually covers half to all of what changed on the island (shadows and sparkles add a bit).
  // Much smaller or much bigger means it's the wrong unit, however well its colours match.
  function sizePenalty (p, blob) {
    if (!blob) return 0
    const r = (p.drawn.w * p.drawn.h) / (blob.w * blob.h)
    if (r < 0.4) return (0.4 - r) * 1.0
    if (r > 1.4) return (r - 1.4) * 0.5
    return 0
  }

  // Width and height of whatever stands on a spot: the patch that differs from the empty island,
  // grown out from the spot's centre.
  function blobAt (frame, empty, slot) {
    const x0 = Math.max(empty.x, slot.x - 70)
    const x1 = Math.min(empty.x + empty.width - 1, slot.x + 70)
    const y0 = Math.max(empty.y, slot.y - 60)
    const y1 = Math.min(empty.y + empty.height - 1, slot.y + 60)
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const on = new Uint8Array(w * h)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * frame.width + x) * 4
        const j = ((y - empty.y) * empty.width + (x - empty.x)) * 4
        const f = frame.data
        const e = empty.data
        if (Math.abs(f[i] - e[j]) + Math.abs(f[i + 1] - e[j + 1]) + Math.abs(f[i + 2] - e[j + 2]) > 60) on[(y - y0) * w + (x - x0)] = 1
      }
    }
    // Flood fill from the changed pixels in the spot's centre, bridging 1-pixel gaps.
    const seen = new Uint8Array(w * h)
    const stack = []
    for (let y = slot.y - BOX.dy; y <= slot.y + BOX.dy; y++) {
      for (let x = slot.x - BOX.dx; x <= slot.x + BOX.dx; x++) {
        const k = (y - y0) * w + (x - x0)
        if (on[k]) { seen[k] = 1; stack.push(k) }
      }
    }
    if (!stack.length) return null
    let minX = w, maxX = 0, minY = h, maxY = 0
    while (stack.length) {
      const k = stack.pop()
      const x = k % w
      const y = (k - x) / w
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const n = ny * w + nx
          if (on[n] && !seen[n]) { seen[n] = 1; stack.push(n) }
        }
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1 }
  }

  function hsv (b, g, r) {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    let h = 0
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    return [(h * 60 + 360) % 360, max ? d / max : 0, max]
  }

  function pixelHsv (frame, x, y) {
    const i = (y * frame.width + x) * 4
    return hsv(frame.data[i], frame.data[i + 1], frame.data[i + 2])
  }

  // The rock under the shop island is showing (unit tooltips can cover the ground, never the rock).
  function islandThere (frame) {
    return ROCK_POINTS.every(([x, y]) => {
      const [h, s, v] = pixelHsv(frame, x, y)
      return h >= 215 && h <= 265 && s >= 0.05 && s <= 0.28 && v >= 75 && v <= 185
    })
  }

  // The small shop island is showing: olive ground on top, and its grey-blue rock underneath
  // exactly where a shop island's rock sits (an opponent's island is bigger and has no rock there).
  function shopOpen (frame) {
    const ground = GROUND_POINTS.filter(([x, y]) => {
      const [h, s, v] = pixelHsv(frame, x, y)
      return h >= 60 && h <= 100 && s >= 0.12 && s <= 0.35 && v >= 100 && v <= 210
    }).length
    return ground >= 5 && islandThere(frame)
  }

  // Reads a shop from the first frame it is open (every slot is still full then).
  // Takes the largest layout (6, 3 or 1 units) whose slots all hold a unit; failing that,
  // the layout whose weakest slot matches best, with every slot marked unsure.
  function readShop (levels, templates, knownSize, empty = null) {
    const cache = new Map()
    const read = s => {
      const key = `${s.x},${s.y}`
      if (!cache.has(key)) cache.set(key, readSlot(levels, templates, s, empty ? blobAt(levels[0], empty, s) : null))
      return cache.get(key)
    }
    let best = null
    for (const size of knownSize ? [knownSize] : [6, 3, 1]) {
      const slots = LAYOUTS[size].map(s => ({ ...s, ranked: read(s) }))
      // A wrong layout always has a slot standing on bare ground, so its weakest slot scores low.
      const fit = Math.min(...slots.map(s => s.ranked[0] ? s.ranked[0].score : 0))
      if (fit >= LAYOUT_MATCH) { best = { size, slots, fit }; break }
      if (!best || fit > best.fit) best = { size, slots, fit }
    }
    return {
      size: best.size,
      slots: best.slots.map(s => {
        const [a, b] = s.ranked
        return {
          x: s.x,
          y: s.y,
          options: s.ranked.slice(0, 5),
          sure: !!a && a.score >= MATCH && (!b || a.score - b.score >= CLOSE_CALL)
        }
      })
    }
  }

  // The shop island stays on screen, empty, between shops. A shop is open when its units stand on it,
  // which shows as the middle of each spot differing from the empty island.
  const OCCUPIED = 0.2
  const BOX = { dx: 14, dy: 8 }
  // Bare ground on the shop island, below where units stand; a unit's card or the Tips panel covers it when open.
  const PANEL_POINTS = [[960, 470], [1000, 455], [1110, 445]]
  const SPOTS = {
    upper: LAYOUTS[6].slice(0, 3),
    lower: LAYOUTS[6].slice(3),
    middle: LAYOUTS[3]
  }

  // Share of a slot's box that differs from the empty island. empty = {x, y, width, height, data} (BGRA).
  function filled (frame, empty, s) {
    let n = 0
    let diff = 0
    for (let y = s.y - BOX.dy; y <= s.y + BOX.dy; y++) {
      for (let x = s.x - BOX.dx; x <= s.x + BOX.dx; x++) {
        const i = (y * frame.width + x) * 4
        const j = ((y - empty.y) * empty.width + (x - empty.x)) * 4
        const f = frame.data
        const e = empty.data
        n++
        if (Math.abs(f[i] - e[j]) + Math.abs(f[i + 1] - e[j + 1]) + Math.abs(f[i + 2] - e[j + 2]) > 60) diff++
      }
    }
    return diff / n
  }

  // Parchment-coloured, like the game's panels.
  function parchment (frame, x, y) {
    const [h, s, v] = pixelHsv(frame, x, y)
    return h >= 20 && h <= 52 && s >= 0.18 && s <= 0.6 && v >= 150
  }

  // A game panel covers part of the shop, so what's under it can't be judged.
  // Two of the points must be covered: one could be a stray sparkle or a unit's shadow.
  function panelOpen (frame) {
    return PANEL_POINTS.filter(([x, y]) => parchment(frame, x, y)).length >= 2
  }

  // Which shop layout is standing on the island right now: 6, 3, 1, or 0 for none or partial.
  // Checked largest first: the units of a 6 shop can reach into the 3 shop's row.
  function shopLayout (frame, empty) {
    if (!shopOpen(frame) || panelOpen(frame)) return 0
    const on = list => list.map(s => filled(frame, empty, s) >= OCCUPIED)
    const upper = on(SPOTS.upper)
    const lower = on(SPOTS.lower)
    const middle = on(SPOTS.middle)
    if (lower.every(Boolean) && upper.every(Boolean)) return 6
    if (middle.every(Boolean)) return 3
    if (middle[1] && !middle[0] && !middle[2] && !lower.some(Boolean) && !upper.some(Boolean)) return 1
    return 0
  }

  // For each slot of a layout: true if a unit is on it, false if it's empty, null if a panel hides it.
  // Returns null altogether when the island itself is hidden behind a panel.
  function slotsFilled (frame, empty, size) {
    const covered = ([x, y]) => parchment(frame, x, y)
    if (!islandThere(frame)) return ROCK_POINTS.some(covered) || panelOpen(frame) ? null : LAYOUTS[size].map(() => false)
    return LAYOUTS[size].map(s => covered([s.x, s.y]) ? null : filled(frame, empty, s) >= OCCUPIED)
  }

  // The player's island grid, shown while a unit is dragged or Island Stats is open (frame coordinates).
  // Tiles are 26 x 21.65 px; board x runs -8..10 and y -8..7 (the same numbers the log uses).
  const GRID = { x0: 66.5, y0: 186, w: 26, h: 21.65, rows: [11, 13, 15, 17, 19, 19, 19, 19, 19, 19, 19, 19, 17, 15, 13, 11], cols: 19, offset: 8 }

  function gray (frame, x, y) {
    const i = (y * frame.width + x) * 4
    return (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3
  }

  // How much darker a grid line is than the ground beside it (median along the edge).
  function edgeContrast (frame, horizontal, at, from, to) {
    const p = Math.round(at - 0.1)
    const vals = []
    for (let t = Math.floor(from) + 3; t < Math.floor(to) - 2; t++) {
      const [line, near] = horizontal
        ? [(gray(frame, t, p) + gray(frame, t, p + 1)) / 2, (gray(frame, t, p - 3) + gray(frame, t, p + 4)) / 2]
        : [(gray(frame, p, t) + gray(frame, p + 1, t)) / 2, (gray(frame, p - 3, t) + gray(frame, p + 4, t)) / 2]
      vals.push(near - line)
    }
    vals.sort((a, b) => a - b)
    return vals[vals.length >> 1]
  }

  // Share of a tile's rim with the game's reddish "taken" tint.
  function tintShare (frame, x0, y0, x1, y1) {
    let n = 0
    let hit = 0
    for (let y = y0 + 1; y < y1 - 1; y++) {
      for (let x = x0 + 1; x < x1 - 1; x++) {
        if (y > y0 + 3 && y < y1 - 4 && x > x0 + 3 && x < x1 - 4) continue
        const i = (y * frame.width + x) * 4
        const b = frame.data[i]
        const g = frame.data[i + 1]
        const r = frame.data[i + 2]
        n++
        if (r > b + 4 && r - g > 8 && Math.max(r, g, b) < 200) hit++
      }
    }
    return n ? hit / n : 0
  }

  // Mean colour and texture of a tile's inside: { b, g, r, spread }.
  function tileLook (frame, x0, y0, x1, y1) {
    let n = 0
    const sum = [0, 0, 0]
    const sq = [0, 0, 0]
    for (let y = y0 + 3; y < y1 - 2; y++) {
      for (let x = x0 + 3; x < x1 - 2; x++) {
        const i = (y * frame.width + x) * 4
        for (let k = 0; k < 3; k++) { const v = frame.data[i + k]; sum[k] += v; sq[k] += v * v }
        n++
      }
    }
    const mean = sum.map(v => v / n)
    const spread = sq.reduce((a, v, k) => a + Math.sqrt(Math.max(0, v / n - mean[k] * mean[k])), 0) / 3
    return { b: mean[0], g: mean[1], r: mean[2], spread }
  }

  // The round counter at the top left ("13/16"), in gray. The "/16" is found first; the digit just
  // before it is matched against digits cut from Jared's games. Rounds 10 and up put the counter's
  // slash at x >= 131 (a "1" stands before the last digit); 11 is matched whole since it's so narrow.
  // Digits 0 and 9 haven't been seen yet, so rounds 9 and 10 read as unknown.
  const ROUND = {
    y: 13,
    h: 19,
    w: 10,
    slashW: 24,
    slash16: 'pKSkpJtmjKSkpKSkpKSkpKSkpKSjfEtxkaSkoWs0MIihkG2MoaSkop10XGF7P1R5W6SkokSdekBNNktEoaSkjT5ThXY5I2B9TqSkmyzVbzF20rc2n6KLNYzp9/W/IVl9TqSkhETlPSZr/ME2oJdDh86ZlueLFTtXTqSkYmzUNE9Z/8I1n1pgtThLMEEYHCo2TqSkPqiuO3JY/8I1jTa8Rj04KhoOLT5DTqOiH9x2XnVX/8IzaF/ECj6v5dxyIkNHTqOMO+5AfnVY/8IzQKWlUuT0+fzxYCZGTqFnatc5kHVY/8IxL8m9xGYaM8f9yCM+Tp9Eo69AnXVY/8IuNNfhUhogHznm7zY3Tpsi3XhfonVY/8IsNdnZHSIqKRiS9jk3Tog19D6Co3VY/8IuK8/uRzA+MCVY1Cg+TmNq4TCUo3VY/8IfFqP8vDBKUCdfkSBDS0Gmsj2fpHVY/8INMkvn97xNLiaYOTNERiThfFqjpHVY/rsQZ0hq6PjitqtVKUFFUDP7QH6kpHVOr0opfn1CTbHkuUknP0JFXmzqKZOkpIcqKiRggX51RS0jJzRARURGRqe0PZykpJ2CJ0FpaHF1SDAkNUNFRUVG',
    glyphs: {
      1: 'pKSkpKSkpKSkpKSkpKSko6Ofi22kpKSkpJ15Qz5ApKSkpKNHRYrZj6SkpKSjPC+P/ZakpKSko41Ggf+XpKSkpKSgXIH/l6SkpKSkol6B/5ekpKSkpKJegf+XpKSkpKSiXoH/l6SkpKSkol6B/5ekpKSkpKJegf+XpKSkpKSiXoH/l6SkpKSkol6B/5ekpKSkpKJegf+XpKSkpKSiXoH+kaSkpKSkol5xnUCkpKSkpKN3Kk97pKSkpKSjnpCUmw==',
      2: 'vb29vb69vb6+vr29vby7qI+Imrq+vr6lVUBaYUtKvrygOYG/4fPhh760QYZsRU+q+vK8clygPZuKO7j+uy7GvjaluX9K/7cf7/ZbaLyiLPu3G+2nLZa8kT7qukZWNZW4rjmQVLucYZW1sVleXVS8ubC5s1dZXk6rvby8tV9XYkmhvL68tl1WaR1WcHO+t2hVv4dzfX9/uGhQ1vnw7+/v7oc2w+jr6+vr692NJzY5OTk5OTk6t6empqampqampw==',
      3: 'pKSkpKSkpKSkpKOPc3FxcXFxcXKbNFxhYWFhYWFVTW7v9fX19fTlWiOwzMzMzNHmZkc5PT49NRxoZEKYm5mZkUZXcx5HlaOinkxZ4+7HdS2ko2ZIscHv+/WRpKFpHTU9M6b99KSDTHeNj3o4yP16MDJyoaOfWnz/OrFhaaKko3NZ/mP1rzqHn51UeNYu4/KIQExIR8haVWXm78KiqcNwG5dMTJK7v5tOFz+jmH1dS0dTPyZjpKOfl5SRhi1DZA==',
      4: 'paWlpaWin6SlpaWlpZ+CXFaTpaWlpaJyT141h6WlpaWST52IUJulpaWjcGS4VnulpaSll1CZiVWYo6SPpHZcrVBjZXqRXptSjnwhQlE9Vkt9VKM4LK6yLkNgVIF3ME3dvSpKWE2nUDFa4cdBOzmB59TP2vj019PJvO/v7vH8+u/tuGZmXFJ05M5bUDdtYTUkQtm5ICAkll0+PknVrSIrLmk7SUg7jE8eLS0+Q1Q5GB0gKy4qP1JCKScqLi8uJQ==',
      5: 'pKSkpKSkpKSkpJGkpKGQcnFxcXFbpKSNOFthYWFhTqKXM4/w9fX1006gR3bhr6iopVJOmiDozis7OD5hTpgj9c0gMDE0W06SLPbPbsfpymNOjDT39+/v9/vvToY943syKTKc/E6DK0JUgYh6PrJOkhAchqGin3NPTHBBWV6hpKOLMkYxtc5AWouYZVVDHub6y3BERkiySkZ69frtz7vKfWaMOnXb8O7RZzmbopBYOkFFOl1ToqSjl5GMiY6IMA==',
      6: 'pKSkpKSkpKN8S6Skop10XGF7P1SkpI0+U4V2OSNgoos1jOn39b8hWZdDh86ZlueLFTtaYLU4SzBBGBwqNrxGPTgqGg4tPl/ECj6v5dxyIkOlpVLk9Pn88WAmyb3EZhozx/3II9fhUhogHznm7zbZ2R0iKikYkvY5z+5HMD4wJVjUKKP8vDBKUCdfkSBL5/e8TS4mmDkzSGro+OK2q1UpQX1CTbHkuUknP0J+dUUtIyc0QEVEcXVIMCQ1Q0VFRQ==',
      7: 'paWlpaWlpaWlpaWkjG9sbGxsbGyli0xib29vb29kllKA5vb29vb1tmxBqMjJycnU63R1QVBSUlA+crVGoJWSkpKDQ5V4SaWlpaWkdluwQUSlpaWlmVOThipFpaWlpX5WuEo0WaWlpZ5bh68vT12lpaWMUL2MNVtCpaWkcWfhcj1GLaWlnlaP73AtLiylo4s4qviWISkupZdaJ6P6vi0mLp1pOi1mwmcfKy51PkJJJzEfKS4sQz9SQiUhKi4vKA==',
      8: 'paWlpaWioaOlpaWlpZt5X1pifZ6lpZleWYeYgVFgpaFpX8fq8fTHUaSATpiKb4LO+Y+dUo2SQmhXZ+yjlUfKvlFib0rRc5RGyPfDcUBblC2fVXfl/e/FqEMio2o9oc3x/vS1TYVJkGY/cL/z/NJQjMNQbUo4g+D8R9PRU2ZIPjVp5kja7nUwOFNAKLhKpPfXeEE2K1Wrdk6w7+7MrKOcUZdJMnWyx7F3NB91PTg0JSQiHyYqQz9SQSYnKy0vJw==',
      11: 'paWlpaWlpaWlpaSbgm2OpKSagG5xUVFFX49uUFJDRYXNjFJLR4vQgjaU9JZRRTif9YpIhPOWW4ZCkPWHYoXzllyeWZD1hmKF85ZcnlmQ9YdihfOWXJ1ZkPWIYoXzllyXTI/1hmKF85ZYby6P9YVihfOVP0Ytj/WFYoXzkyxJNY/1hWKF85MwVjaP9YVihfOTOU0kj/WFYITtiDExHY7uek5ihz4iKB1pgzUwIi8pJyshGh4iPU0/KSotLSssKQ=='
    }
  }
  let roundArt = null
  function roundTemplates () {
    if (!roundArt) {
      const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
      roundArt = { slash16: bytes(ROUND.slash16), glyphs: Object.entries(ROUND.glyphs).map(([d, s]) => ({ d: Number(d), px: bytes(s) })) }
    }
    return roundArt
  }

  // Normalized correlation of the frame's gray box at (x, ROUND.y), w wide, with a template.
  function grayCorrelation (frame, x, w, t) {
    const n = w * ROUND.h
    const a = new Float64Array(n)
    let ma = 0
    let mb = 0
    for (let j = 0; j < ROUND.h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i
        a[k] = gray(frame, x + i, ROUND.y + j)
        ma += a[k]
        mb += t[k]
      }
    }
    ma /= n
    mb /= n
    let ab = 0
    let aa = 0
    let bb = 0
    for (let k = 0; k < n; k++) {
      const da = a[k] - ma
      const db = t[k] - mb
      ab += da * db
      aa += da * da
      bb += db * db
    }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
  }

  // The round shown on screen, or null when the counter isn't showing or a digit is unclear.
  // On frames the digits weren't cut from, the right digit scored 0.69-0.91 and beat the next best by 0.25+.
  function readRound (frame) {
    const art = roundTemplates()
    let slash = { v: -1, x: 0 }
    // The counter shifts left or right with the number of portraits before it (one or two so far).
    for (let x = 60; x < 175; x++) {
      const v = grayCorrelation(frame, x, ROUND.slashW, art.slash16)
      if (v > slash.v) slash = { v, x }
    }
    if (slash.v < 0.55) return null
    // Rounds 10 and up have a 1 in front of the last digit (it scores 0.5-1 there; single digits under 0.25).
    const one = art.glyphs.find(g => g.d === 1)
    const twoDigits = Math.max(...[19, 20, 21, 22, 23].map(dx => grayCorrelation(frame, slash.x - dx, ROUND.w, one.px))) >= 0.45
    const scores = art.glyphs.filter(g => !(twoDigits && g.d === 11)).map(g => ({
      d: g.d,
      v: Math.max(...[-1, 0, 1].map(dx => grayCorrelation(frame, slash.x - ROUND.w + dx, ROUND.w, g.px)))
    })).sort((a, b) => b.v - a.v)
    if (scores[0].v < 0.65 || scores[0].v - scores[1].v < 0.2) return null
    const d = scores[0].d
    return d === 11 ? 11 : twoDigits ? 10 + d : d
  }

  function isRoundOne (frame) {
    return readRound(frame) === 1
  }

  // Reads the island grid: for each tile '#' (a unit stands there), '.' (empty) or '?' (hidden by a sprite).
  // Returns null when the grid isn't showing. Keys are "x,y" in board numbers.

  // Empty tiles are told apart by their plain blue ground; live video often shows only one of their lines.
  const BARE_LINES = 1
  function islandTiles (frame) {
    const tiles = {}
    let lined = 0
    let count = 0
    // Live video is softer than a screenshot and a full island hides many lines, so two edges count here.
    GRID.rows.forEach((width, r) => {
      const start = (GRID.cols - width) / 2
      for (let c = start; c < start + width; c++) {
        const xa = GRID.x0 + c * GRID.w
        const xb = xa + GRID.w
        const ya = GRID.y0 + r * GRID.h
        const yb = ya + GRID.h
        const lines = [edgeContrast(frame, true, ya, xa, xb), edgeContrast(frame, true, yb, xa, xb), edgeContrast(frame, false, xa, ya, yb), edgeContrast(frame, false, xb, ya, yb)]
        const visible = lines.filter(v => v > 4).length
        const tint = tintShare(frame, Math.floor(xa), Math.floor(ya), Math.floor(xb), Math.floor(yb))
        count++
        if (visible >= 2) lined++
        const look = tileLook(frame, Math.floor(xa), Math.floor(ya), Math.floor(xb), Math.floor(yb))
        // Empty: the grid's plain blue ground, with lines round it and no "taken" tint.
        const bare = tint < 0.05 && look.b - look.r > 30 && look.spread < 16
        tiles[`${c - GRID.offset},${r - GRID.offset}`] = tint >= 0.15 && visible >= 2 ? '#' : bare && visible >= BARE_LINES ? '.' : '?'
      }
    })
    // Without the grid, at most about a quarter of tiles show two lined edges (on a packed island with
    // the grid showing it's still over 60%).
    return lined / count >= 0.42 ? tiles : null
  }

  // Where a unit's picture is centred when it stands at board (x, y): the middle of its tiles.
  function tileCentre (x, y, w, h) {
    return {
      x: Math.round(GRID.x0 + (x + GRID.offset + w / 2) * GRID.w),
      y: Math.round(GRID.y0 + (y + GRID.offset + 1 - h / 2) * GRID.h)
    }
  }

  // A library picture taller than its tiles stands on their bottom edge and reaches up, so its middle
  // is above the tiles' middle; the Big Tree's is about 17 px up, close to a row. Searches start a little
  // up (a third of what full bottom-standing would give; some art, like the Bee Keeper's, hangs lower).
  // Set on each picture as p.lift when the templates load.
  // A thin unit (the Solaris Saber, a sword lying flat) is drawn in the middle of a mostly empty picture,
  // so it's its drawn part that stands on the tiles. k: the picture's scale down from the frame (half size: 2).
  function lift (u, p, k = 1) {
    const d = p.drawn
    if (d.h * 2 > p.h) return Math.round(Math.min(0, u.h * GRID.h - p.h * k) / 3)
    return Math.round(Math.min(0, u.h * GRID.h - d.h * k) / 3 - ((d.y0 + d.y1 + 1) / 2 - p.h / 2) * k)
  }

  // Looks for each unit in ids on the island, on spots whose tiles aren't plainly empty. Returns a few
  // separate spots per id, best first (more when an id is listed more than once).
  // Returns [{ id, x, y, score }] with each unit's best spot (board numbers), or score -1 when none fits.
  function findOnIsland (frame, tiles, templates, units, ids) {
    const keys = Object.keys(tiles)
    const wanted = new Map()
    for (const id of ids) wanted.set(id, (wanted.get(id) || 0) + 1)
    return [...wanted].flatMap(([id, n]) => {
      const t = templates.get(id)
      const u = units.get(id)
      if (!t || !u) return [{ id, x: 0, y: 0, score: -1 }]
      const quick = [t.full[MID], t.full[SCALES.length + MID]]
      const spots = []
      for (const key of keys) {
        const [x, y] = key.split(',').map(Number)
        let ok = true
        for (let i = 0; i < u.w && ok; i++) for (let j = 0; j < u.h && ok; j++) { const s = tiles[`${x + i},${y - j}`]; if (!s || s === '.') ok = false }
        if (!ok) continue
        const c = tileCentre(x, y, u.w, u.h)
        spots.push({ x, y, c, v: Math.max(...quick.map(p => bestNear(frame, p, c.x, c.y + p.lift, 4, 8, 2))) })
      }
      spots.sort((a, b) => b.v - a.v)
      const refined = spots.slice(0, 2 + n).map(s => ({ id, x: s.x, y: s.y, score: Math.max(...t.full.map(p => bestNear(frame, p, s.c.x, s.c.y + p.lift, 4, 8))) }))
      refined.sort((a, b) => b.score - a.score)
      // The best spots that don't overlap each other, best first; a couple more than wanted, since
      // the best one may already be taken by a copy the app has placed.
      const picked = []
      for (const f of refined) {
        if (!picked.some(q => f.x < q.x + u.w && q.x < f.x + u.w && f.y - u.h < q.y && q.y - u.h < f.y)) picked.push(f)
      }
      return picked.length ? picked : [{ id, x: 0, y: 0, score: -1 }]
    })
  }

  // Small units are only ~26 px wide at 1280x720. When the game runs at a higher resolution, the
  // capture page also sends the island at full size: hi = { scale, x0, y0, width, height, data }
  // (scale = full size / 1280; x0, y0 = where the crop starts, in full-size pixels).
  const small = u => u.w * u.h <= 2
  function sharpPictures (t, hi) {
    const key = `${hi.scale}:${hi.width}`
    if (!t.sharp.has(key)) {
      t.sharp.set(key, t.pics.flatMap(({ tpl, base }) => [tpl, mirror(tpl)].flatMap(q => SCALES.map(k => prepare(q, base * hi.scale * k, hi.width)))))
    }
    return t.sharp.get(key)
  }
  // Best fit of unit t near (cx, cy) (1280x720 coordinates) on the full-size island: { score, gap }.
  function sharpScore (hi, t, cx, cy, reach) {
    const x = cx * hi.scale - hi.x0
    const y = cy * hi.scale - hi.y0
    const r = Math.round(reach * hi.scale)
    let score = -1
    let gap = 0
    for (const p of sharpPictures(t, hi)) {
      const at = {}
      bestNear(hi, p, x, y, r, r, 2, at)
      const v = bestNear(hi, p, at.x, at.y, 1, 1, 1, at)
      if (v > score) { score = v; gap = colourGap(hi, p, at.x, at.y) }
    }
    return { score, gap }
  }

  // How well each unit we think is on the island matches the picture at its spot: [{ key, score }].
  function verifyOnIsland (frame, templates, units, pieces, hi = null) {
    return pieces.map(p => {
      const t = templates.get(p.id)
      const u = units.get(p.id)
      if (!t || !u) return { key: p.key, score: -1 }
      const c = tileCentre(p.x, p.y, u.w, u.h)
      let best = -1
      let spot = null
      for (const q of t.full) {
        const at = {}
        bestNear(frame, q, c.x, c.y + q.lift, 4, 8, 2, at)
        let v = bestNear(frame, q, at.x, at.y, 1, 1, 1, at)
        if (v > best && colourGap(frame, q, at.x, at.y) > COLOUR_GAP) v = 0 // right shape, wrong colours
        if (v > best) { best = v; spot = at }
      }
      if (hi && small(u) && spot) {
        const sharp = u.w * u.h === 1 ? sharpScore(hi, t, c.x, c.y, 4) : sharpScore(hi, t, spot.x, spot.y, 1)
        best = sharp.gap > COLOUR_GAP ? 0 : sharp.score
      }
      return { key: p.key, score: best }
    })
  }

  // Names units on the island the app doesn't know about yet: every shop unit is tried on every spot
  // where it would stand on taken tiles (at least half '#', none '.'). Returns sightings scoring at
  // least minScore, best first: [{ id, x, y, score }]. skip: tile keys already accounted for.
  function discoverOnIsland (frame, tiles, templates, units, skip = new Set(), minScore = 0.75) {
    const keys = Object.keys(tiles).filter(k => !skip.has(k))
    const sightings = []
    for (const t of templates.values()) {
      if (!t.inShop) continue
      const u = units.get(t.id)
      if (!u) continue
      const quick = [t.full[MID], t.full[SCALES.length + MID]]
      for (const key of keys) {
        const [x, y] = key.split(',').map(Number)
        let taken = 0
        let ok = true
        for (let i = 0; i < u.w && ok; i++) {
          for (let j = 0; j < u.h && ok; j++) {
            const k = `${x + i},${y - j}`
            const s = tiles[k]
            if (!s || s === '.' || skip.has(k)) ok = false
            else if (s === '#') taken++
          }
        }
        if (!ok || taken * 2 < u.w * u.h) continue
        const c = tileCentre(x, y, u.w, u.h)
        const v = Math.max(...quick.map(p => bestNear(frame, p, c.x, c.y + p.lift, 2, 4, 2)))
        if (v >= minScore - 0.18) sightings.push({ id: t.id, x, y, c, v })
      }
    }
    // Sharpen the promising ones at every size.
    const out = []
    for (const s of sightings) {
      const t = templates.get(s.id)
      const score = Math.max(...t.full.map(p => bestNear(frame, p, s.c.x, s.c.y + p.lift, 3, 6)))
      if (score >= minScore) out.push({ id: s.id, x: s.x, y: s.y, score })
    }
    return out.sort((a, b) => b.score - a.score)
  }

  // ---------- A unit's card (shown while the mouse rests on a unit) ----------

  // The card: a parchment box about 280x160 (at 1280x720) with coloured tag boxes (Tier, faction, ...)
  // along its bottom, in the faction's colour. Returns its box { x0, y0, x1, y1 } or null.
  const CARD = { step: 4, minW: 200, maxW: 380, minH: 90, maxH: 260, fill: 0.7, statsFill: 0.6, unitW: 300 }
  // A tag box: darker than the parchment and not its brown (the card's text is dark brown).
  // Tinker tags are brown too, but solid: a few pixels in a row of the same flat mid brown, where
  // the text's strokes are thin and darker.
  function tagColour (frame, x, y) {
    const [h, s, v] = pixelHsv(frame, x, y)
    if (v <= 150 && s >= 0.2 && (h < 18 || h > 55)) return true
    const flat = xx => { const [hh, ss, vv] = pixelHsv(frame, xx, y); return hh >= 20 && hh <= 40 && ss >= 0.6 && vv >= 140 && vv <= 165 }
    // Basic units' tags are plain grey, which nothing else on a card is.
    const grey = xx => { const [, ss, vv] = pixelHsv(frame, xx, y); return ss < 0.12 && vv >= 70 && vv <= 135 }
    return x + 6 < frame.width && ((flat(x) && flat(x + 3) && flat(x + 6)) || (grey(x) && grey(x + 3) && grey(x + 6)))
  }
  function unitCard (frame) {
    const { step } = CARD
    const cw = Math.floor(frame.width / step)
    const ch = Math.floor(frame.height / step)
    const on = new Uint8Array(cw * ch)
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) on[j * cw + i] = parchment(frame, i * step, j * step) ? 1 : 0
    const label = new Int32Array(cw * ch)
    const stack = []
    let next = 0
    for (let start = 0; start < on.length; start++) {
      if (!on[start] || label[start]) continue
      const id = ++next
      let minI = cw
      let maxI = 0
      let minJ = ch
      let maxJ = 0
      label[start] = id
      stack.push(start)
      while (stack.length) {
        const k = stack.pop()
        const i = k % cw
        const j = (k - i) / cw
        if (i < minI) minI = i
        if (i > maxI) maxI = i
        if (j < minJ) minJ = j
        if (j > maxJ) maxJ = j
        // Text and tag boxes break the parchment up, so neighbours two cells away count too.
        for (let dj = -2; dj <= 2; dj++) {
          for (let di = -2; di <= 2; di++) {
            const ii = i + di
            const jj = j + dj
            if (ii < 0 || jj < 0 || ii >= cw || jj >= ch) continue
            const q = jj * cw + ii
            if (on[q] && !label[q]) { label[q] = id; stack.push(q) }
          }
        }
      }
      if ((maxI - minI + 1) * step < CARD.minW) continue
      // Sandy units next to the card can join it, so the card is the solid part: the longest run of
      // rows mostly parchment, then the columns mostly parchment within those rows.
      const inRow = j => { let n = 0; for (let i = minI; i <= maxI; i++) if (label[j * cw + i] === id) n++; return n }
      // The title gap and the row of tag boxes are only a few rows tall, so short gaps don't end the run.
      let best = [0, -1]
      let from = -1
      let last = -1
      for (let j = minJ; j <= maxJ + 1; j++) {
        const solid = j <= maxJ && inRow(j) >= (maxI - minI + 1) * 0.5
        if (solid) {
          if (from < 0 || j - last > 7) from = j
          last = j
          if (last - from > best[1] - best[0]) best = [from, last]
        }
      }
      // The card is drawn over everything, so what joins it is only the edges of things around it: far
      // above the card, nothing joined may be as wide as a big panel (the Soul Engine's logs touching a
      // Well's card are fine; a few rows of the bar along the top of the screen can touch it too).
      if (best[1] < 0) continue
      let wideAbove = 0
      for (let j = minJ; j < best[0] - 6; j++) wideAbove = Math.max(wideAbove, inRow(j))
      if (wideAbove > (maxI - minI + 1) * 0.4) continue
      const [top, bottom] = best
      const inCol = i => { let n = 0; for (let j = top; j <= bottom; j++) if (label[j * cw + i] === id) n++; return n }
      let left = -1
      let right = -1
      for (let i = minI; i <= maxI; i++) if (inCol(i) >= (bottom - top + 1) * 0.5) { if (left < 0) left = i; right = i }
      if (left < 0) continue
      minI = left
      maxI = right
      minJ = top
      maxJ = bottom
      let n = 0
      for (let j = minJ; j <= maxJ; j++) for (let i = minI; i <= maxI; i++) if (label[j * cw + i] === id) n++
      const w = (maxI - minI + 1) * step
      const h = (maxJ - minJ + 1) * step
      if (w < CARD.minW || w > CARD.maxW || h < CARD.minH || h > CARD.maxH) continue
      // A weapon's card has a column of coloured stat boxes beside its text (the Solaris Saber's is 0.66
      // parchment); a unit card is under 300 wide, where the Island Stats panel is wider.
      if (n / ((maxI - minI + 1) * (maxJ - minJ + 1)) < (w <= CARD.unitW ? CARD.statsFill : CARD.fill)) continue
      const box = { x0: minI * step, y0: minJ * step, x1: maxI * step + step - 1, y1: maxJ * step + step - 1 }
      // The tag boxes: along the bottom fifth, across at least a third of the card.
      let green = 0
      let cols = 0
      for (let x = box.x0 + 4; x < box.x1 - 4; x += 2) {
        cols++
        for (let y = Math.round(box.y1 - (box.y1 - box.y0) * 0.2); y < box.y1; y += 2) if (tagColour(frame, x, y)) { green++; break }
      }
      if (green / cols >= 0.33) return box
    }
    return null
  }

  // The card's title (the unit's name) as black text on white, three times its size and with a margin,
  // ready for text recognition: { width, height, data } with one byte per pixel.
  function cardTitle (frame, box, k = 3) {
    const w = box.x1 - box.x0
    const h = box.y1 - box.y0
    const x0 = box.x0 + Math.round(w * 0.04)
    const x1 = box.x1 - Math.round(w * 0.04)
    const y0 = box.y0 + Math.round(h * 0.05)
    // The title sits at the same height on every card, however tall; low enough for letters like y to keep their tails.
    const y1 = box.y0 + Math.min(Math.round(w * 0.13), Math.round(h * 0.33))
    const pad = 20
    const width = (x1 - x0) * k + 2 * pad
    const height = (y1 - y0) * k + 2 * pad
    const data = new Uint8Array(width * height).fill(255)
    const lum = (x, y) => {
      const i = (y * frame.width + x) * 4
      return (frame.data[i] + frame.data[i + 1] + frame.data[i + 2]) / 3
    }
    for (let y = 0; y < (y1 - y0) * k; y++) {
      const fy = y0 + y / k
      const ya = Math.floor(fy)
      const ty = fy - ya
      for (let x = 0; x < (x1 - x0) * k; x++) {
        const fx = x0 + x / k
        const xa = Math.floor(fx)
        const tx = fx - xa
        const v = (lum(xa, ya) * (1 - tx) + lum(xa + 1, ya) * tx) * (1 - ty) + (lum(xa, ya + 1) * (1 - tx) + lum(xa + 1, ya + 1) * tx) * ty
        if (v < 110) data[(y + pad) * width + x + pad] = 0
      }
    }
    return { width, height, data }
  }

  // The island tile under a point of the frame, or null.
  function tileAt (px, py) {
    const c = Math.floor((px - GRID.x0) / GRID.w)
    const r = Math.floor((py - GRID.y0) / GRID.h)
    const key = `${c - GRID.offset},${r - GRID.offset}`
    return ISLAND_TILES.some(t => t.key === key) ? { x: c - GRID.offset, y: r - GRID.offset, key } : null
  }

  // Where the unit a card names stands: [{ id, x, y, score }] for the spots it could be on, best first.
  // The card is centred over the unit; cursor (frame coordinates, or null) is where the mouse rests,
  // on the unit's tiles or on its picture, which reaches up to three rows above them.
  // earlier: [{ frame, hi }] recent views of the island without the card. The game tints the hovered
  // unit and its synergy partners, so the unit is also scored on those and the better score counts.
  function locateCardUnit (frame, templates, units, id, card, cursor = null, hi = null, earlier = []) {
    const u = units.get(id)
    const t = templates.get(id)
    if (!u || !t) return []
    const mid = (card.x0 + card.x1) / 2
    // A card pushed against the edge of the screen isn't centred over its unit.
    const centred = card.x0 > 2 && card.x1 < frame.width - 3
    const under = cursor && tileAt(cursor.x, cursor.y)
    if (cursor && !under) return []
    const tiles = new Set(ISLAND_TILES.map(t => t.key))
    const spots = []
    for (const { key } of ISLAND_TILES) {
      const [x, y] = key.split(',').map(Number)
      const own = []
      for (let i = 0; i < u.w; i++) for (let j = 0; j < u.h; j++) own.push(`${x + i},${y - j}`)
      if (!own.every(k => tiles.has(k))) continue
      const c = tileCentre(x, y, u.w, u.h)
      if (centred && Math.abs(c.x - mid) > u.w * GRID.w / 2 + 14) continue
      if (!cursor && !(c.y > card.y1 && c.y < card.y1 + 150) && !(c.y < card.y0 && c.y > card.y0 - 150)) continue
      // The hovered unit is drawn over everything else, so its picture covers the mouse (give or take
      // a few pixels of hover area; more would reach the next 1-tile unit along).
      if (cursor && !t.full.some(p => {
        const cy = c.y + p.lift
        return Math.abs(cursor.x - c.x) <= p.w / 2 + 3 && Math.abs(cursor.y - cy) <= p.h / 2 + 3
      })) continue
      spots.push({ key: `${id}@${x},${y}`, id, x, y })
    }
    const views = [{ frame, hi }, ...earlier].map(v => verifyOnIsland(v.frame, templates, units, spots, v.hi))
    return spots.map((p, i) => ({ id, x: p.x, y: p.y, score: Math.max(...views.map(v => v[i].score)) })).sort((a, b) => b.score - a.score)
  }

  // ---------- Watching the island without the grid ----------

  // Every island tile as { key, c, r } (grid column and row) for walking the island.
  const ISLAND_TILES = GRID.rows.flatMap((width, r) => {
    const start = (GRID.cols - width) / 2
    return Array.from({ length: width }, (_, i) => ({ key: `${start + i - GRID.offset},${r - GRID.offset}`, c: start + i, r }))
  })

  // Points of scenery around the island (the rim, cliffs and mountain, not the tiles or what stands on
  // them) used to tell whether the camera is where it was when the island was last read. Tall units
  // reach up to two rows above their tiles, so those rows are left out too.
  const CAMERA_POINTS = (() => {
    const pts = []
    for (let y = 60; y < 650; y += 6) {
      for (let x = 0; x < 640; x += 6) {
        if (x < 300 && y < 45) continue // the counters
        if (x < 340 && y > 470) continue // the buttons, and the inventory or a shop's card when open
        const r = Math.floor((y - GRID.y0) / GRID.h)
        const c = Math.floor((x - GRID.x0) / GRID.w)
        let near = false
        for (const rr of [r, r + 1, r + 2]) {
          if (rr < 0 || rr >= GRID.rows.length) continue
          const start = (GRID.cols - GRID.rows[rr]) / 2
          if (c >= start - 1 && c < start + GRID.rows[rr] + 1) near = true
        }
        if (!near) pts.push([x, y])
      }
    }
    return pts
  })()

  // The gray of the camera points, and which of them look like cloud. Clouds drift over the scenery
  // (a shop arriving brings a bank of them over the island's corners), so points that are cloud in
  // either frame are left out of the comparison.
  function cameraSample (frame) {
    const g = new Float32Array(CAMERA_POINTS.length)
    const cloud = new Uint8Array(CAMERA_POINTS.length)
    CAMERA_POINTS.forEach(([x, y], i) => {
      const k = (y * frame.width + x) * 4
      const b = frame.data[k]
      const gr = frame.data[k + 1]
      const r = frame.data[k + 2]
      const mx = Math.max(r, gr, b)
      g[i] = (r + gr + b) / 3
      cloud[i] = g[i] > 150 && (mx - Math.min(r, gr, b)) / mx < 0.25 ? 1 : 0
    })
    return { g, cloud }
  }

  // How alike two camera samples are, -1..1 (gray correlation over the points neither sees as cloud).
  // The same view scores 0.85-0.98 (units come and go between them); a fight's zoomed-out view or
  // another island scores well under 0.6. Too few points left: can't tell, 0.
  function cameraMatch (a, b) {
    const idx = []
    for (let i = 0; i < a.g.length; i++) if (!a.cloud[i] && !b.cloud[i]) idx.push(i)
    if (idx.length < a.g.length / 3) return 0
    const norm = s => {
      let m = 0
      for (const i of idx) m += s.g[i]
      m /= idx.length
      let sq = 0
      for (const i of idx) sq += (s.g[i] - m) ** 2
      const sd = Math.sqrt(sq / idx.length) || 1
      return idx.map(i => (s.g[i] - m) / sd)
    }
    const na = norm(a)
    const nb = norm(b)
    let s = 0
    for (let k = 0; k < na.length; k++) s += na[k] * nb[k]
    return s / na.length
  }

  // Each tile's mean colour and texture (no grid showing). Bare ground is smooth (spread about 4-9 on
  // the snowy island); a tile under a unit's picture is busy (spread 30+ for nine in ten).
  function tileLooks (frame) {
    const out = {}
    for (const { key, c, r } of ISLAND_TILES) {
      const xa = Math.floor(GRID.x0 + c * GRID.w)
      const ya = Math.floor(GRID.y0 + r * GRID.h)
      out[key] = tileLook(frame, xa, ya, Math.floor(xa + GRID.w), Math.floor(ya + GRID.h))
    }
    return out
  }
  const GROUND_SPREAD = 14
  const groundLike = look => look.spread < GROUND_SPREAD
  const lookChange = (a, b) => Math.abs(a.b - b.b) + Math.abs(a.g - b.g) + Math.abs(a.r - b.r)

  // Tiles hidden by a game panel (the inventory, a unit's card): parchment nearly all over the tile.
  // (Sandy roofs and beehives are parchment-coloured in places, but not across a whole tile.)
  function coveredTiles (frame) {
    const out = []
    for (const { key, c, r } of ISLAND_TILES) {
      const xa = GRID.x0 + c * GRID.w
      const ya = GRID.y0 + r * GRID.h
      let hits = 0
      for (const fx of [0.15, 0.5, 0.85]) {
        for (const fy of [0.15, 0.5, 0.85]) if (parchment(frame, Math.round(xa + fx * GRID.w), Math.round(ya + fy * GRID.h))) hits++
      }
      if (hits >= 8) out.push(key)
    }
    return out
  }

  // The Island Stats panel (bottom right). While it's open, enchantments are drawn over units.
  // Only its lower edge is checked: a unit's card or the Tips panel can cover the rest of that corner.
  const STATS_POINTS = [[948, 676], [1100, 676], [1255, 676], [1000, 710], [1200, 710], [946, 650], [1258, 650]]
  function statsOpen (frame) {
    return STATS_POINTS.filter(([x, y]) => parchment(frame, x, y)).length >= 5
  }

  // Names units standing on the given tiles. Every unit (shop or quest) is tried on every spot whose
  // tiles are at least half among `tiles` and none in `blocked`. Hinted units (bought this round)
  // need minHint, others minScore and a clear lead over any other unit seen on the same tiles.
  // Missing units (just lost from the island, likely moved) are always tried at every size and need
  // minMissing, but still the clear lead: a sold unit is missing too, and must not turn up in a lookalike.
  // Returns non-overlapping sightings, best first: [{ id, x, y, score }].
  // How far the mean colour under a picture is from the picture's own (0-441). Units matched
  // correctly sit at 10-70; lookalikes on bare ground at 73 and above.
  function colourGap (frame, p, cx, cy) {
    const at = (Math.round(cy - p.h / 2) * frame.width + Math.round(cx - p.w / 2)) * 4
    let b = 0, g = 0, r = 0
    for (let i = 0; i < p.n; i++) {
      const k = at + p.offs[i]
      b += frame.data[k]; g += frame.data[k + 1]; r += frame.data[k + 2]
    }
    return Math.hypot(b / p.n - p.mean[0], g / p.n - p.mean[1], r / p.n - p.mean[2])
  }

  // The bar for a missing one-tile unit at a spot only the hard search for it tried (see identifyOnIsland).
  const MISSING_ONE_TILE = 0.7
  const one = u => u.w * u.h === 1
  function identifyOnIsland (frame, templates, units, tiles, { blocked = [], hints = [], missing = [], minScore = 0.65, minHint = 0.55, minMissing = 0.6, lead = 0.08, maxColour = COLOUR_GAP, hi = null } = {}) {
    const want = new Set(tiles)
    const stop = new Set(blocked)
    const hinted = new Set(hints)
    const lost = new Set(missing.filter(id => !hinted.has(id)))
    const bar = id => hinted.has(id) ? minHint : lost.has(id) && !one(units.get(id)) ? minMissing : minScore
    const onIsland = new Set(ISLAND_TILES.map(t => t.key))
    const anchors = new Set()
    for (const k of want) {
      const [x, y] = k.split(',').map(Number)
      for (let dx = -3; dx <= 0; dx++) for (let dy = 0; dy <= 3; dy++) anchors.add(`${x + dx},${y + dy}`)
    }
    const half = { width: FRAME_W / 2, height: FRAME_H / 2, data: resize(frame.data, frame.width, frame.height, FRAME_W / 2, FRAME_H / 2) }
    const seen = []
    for (const t of templates.values()) {
      const u = units.get(t.id)
      if (!u) continue
      // The quick half-size pass scores lower than the full one, so it only rules out clear misses.
      // Small units are blurred to a few pixels at half size (the Carpenter's bench scores 0.3 there), and
      // with the full-size island they're scored again sharply, so their bar is lower.
      const floor = bar(t.id) - (hi && small(u) ? 0.4 : 0.25)
      for (const a of anchors) {
        const [x, y] = a.split(',').map(Number)
        let inside = 0
        let ok = true
        for (let i = 0; i < u.w && ok; i++) {
          for (let j = 0; j < u.h && ok; j++) {
            const k = `${x + i},${y - j}`
            if (!onIsland.has(k) || stop.has(k)) ok = false
            else if (want.has(k)) inside++
          }
        }
        if (!ok || inside * 2 < u.w * u.h) continue
        const c = tileCentre(x, y, u.w, u.h)
        // Where the picture fits best (half-size frame), so the full-size pass can look right there.
        // Each picture keeps its own spot: a unit's pictures (library, in-game) can fit a little apart.
        let v = -1
        const nears = []
        for (const p of t.half) {
          const at = {}
          const q = bestNear(half, p, c.x / 2, (c.y + p.lift) / 2, 3, 5, 1, at)
          nears.push({ x: at.x * 2, y: at.y * 2 })
          if (q > v) v = q
        }
        if (v >= floor) seen.push({ id: t.id, x, y, w: u.w, h: u.h, nears, v })
      }
    }
    // Only the most promising are tried at every size: per anchor the best few, and hinted units.
    seen.sort((a, b) => b.v - a.v)
    const perAnchor = new Map()
    const shortlist = seen.filter(s => {
      const k = `${s.x},${s.y}`
      const n = perAnchor.get(k) || 0
      perAnchor.set(k, n + 1)
      return n < 3 || hinted.has(s.id)
    }).slice(0, 70)
    // Room left over goes to small units that missed their anchor's few (a blurred Carpenter behind a
    // Well that fits the half-size frame better); the full-size island decides between them.
    // (At least a few: a Carpenter 72nd in line was crowded out by one more Force Field picture.)
    if (hi) shortlist.push(...seen.filter(s => small(s) && !shortlist.includes(s)).slice(0, Math.max(70 - shortlist.length, 8)))
    // Bigger units also get a few tries per anchor of their own: blurred small pictures (Tree, Shrub,
    // crystals) fit bits of a big unit at half size and pushed the Cannon Keep off its own anchor.
    const bigPer = new Map()
    shortlist.push(...seen.filter(s => {
      if (small(s)) return false
      const k = `${s.x},${s.y}`
      const n = bigPer.get(k) || 0
      bigPer.set(k, n + 1)
      return n < 3 && !shortlist.includes(s)
    }).slice(0, 20))
    // And each missing unit its best few spots anywhere in the search, past the cap. A one-tile unit
    // found only this way needs a clearer match: Trees and Shrubs fit bits of other units at 0.6-0.65.
    for (const id of lost) shortlist.push(...seen.filter(s => s.id === id && !shortlist.includes(s)).slice(0, 12).map(s => Object.assign(s, { extra: true })))
    for (const s of shortlist) {
      const t = templates.get(s.id)
      s.score = -1
      let spot = null
      // Bigger units are looked for further from the half-size spot: drawn a size up, the Cannon Keep
      // fit 5 px off where its normal-size picture did.
      const r = small(s) ? 2 : 2 + Math.max(s.w, s.h)
      // full holds each picture both ways round at five sizes; half holds each both ways round.
      // A picture whose colours are wrong there (a dark-island picture on snow) doesn't count over one
      // whose colours fit.
      t.full.forEach((p, i) => {
        const at = {}
        const c = s.nears[Math.floor(i / SCALES.length)]
        const v = bestNear(frame, p, c.x, c.y, r, r, 1, at)
        const gap = colourGap(frame, p, at.x, at.y)
        const fits = gap <= maxColour
        if (spot && fits !== (s.gap <= maxColour) ? fits : v > s.score) { s.score = v; s.gap = gap; spot = at }
      })
      // Small units are scored again on the full-size picture: one-tile units around their tile
      // (the quick pass can drift onto a neighbour), taller ones right where they fit best.
      if (hi && small(s)) {
        const c = s.w * s.h === 1 ? tileCentre(s.x, s.y, 1, 1) : spot
        Object.assign(s, sharpScore(hi, t, c.x, c.y, s.w * s.h === 1 ? 4 : 1))
      }
      // The pattern can fit while the colours are wrong (a pale hologram on pale blue ground).
      if (s.gap > maxColour) s.score = -1
    }
    seen.length = 0
    seen.push(...shortlist)
    const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y - a.h < b.y && b.y - b.h < a.y
    const within = (a, b) => a.x >= b.x && a.x + a.w <= b.x + b.w && a.y <= b.y && a.y - a.h >= b.y - b.h
    // A unit bought this round is the likelier of two lookalikes (a Tree over a Shrub).
    const rank = s => s.score + (hinted.has(s.id) ? 0.1 : 0)
    seen.sort((a, b) => rank(b) - rank(a))
    const out = []
    for (const s of seen) {
      if (s.score < (s.extra && one(s) ? MISSING_ONE_TILE : bar(s.id))) continue
      if (out.some(o => overlaps(o, s))) continue
      // A smaller unit that fits wholly inside this one's tiles and scores lower is most likely a piece of
      // its picture (a Shrub in the Red Sun Shrine's pillar on dark ground), so it isn't a rival.
      const rival = seen.find(o => o.id !== s.id && overlaps(o, s) && !(within(o, s) && o.w * o.h < s.w * s.h))
      if (!hinted.has(s.id) && rival && rank(s) - rank(rival) < lead) continue
      out.push(s)
    }
    return out.map(({ id, x, y, score }) => ({ id, x, y, score }))
  }

  // Which slot a point (frame coordinates) is over, or -1.
  function slotAt (shop, p) {
    let best = -1
    let bestD = 50
    shop.slots.forEach((s, i) => {
      const d = Math.hypot(p.x - s.x, p.y - s.y)
      if (d < bestD) { best = i; bestD = d }
    })
    return best
  }

  // The shop stays up while the picked unit is dragged away, so the pick is where the drag began:
  // the latest spot over a unit where the mouse was resting (not mid-drag) before the shop closed.
  // trail = [{t, x, y}] in frame coordinates, oldest first.
  function pickFromTrail (shop, trail, lastOpenAt, closedAt) {
    const pts = trail.filter(p => p.t <= closedAt && p.t >= lastOpenAt - 3000)
    for (let k = pts.length - 1; k > 0; k--) {
      const resting = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) <= 3
      const slot = resting ? slotAt(shop, pts[k]) : -1
      if (slot >= 0) return slot
    }
    return -1
  }

  return { FRAME_W, FRAME_H, TILE, LAYOUTS, resize, pyramid, loadTemplates, readSlot, readShop, bestNear, filled, shopOpen, shopLayout, slotsFilled, panelOpen, blobAt, islandTiles, findOnIsland, discoverOnIsland, verifyOnIsland, tileCentre, GRID, slotAt, pickFromTrail, isRoundOne, readRound, ISLAND_TILES, cameraSample, cameraMatch, tileLooks, unitCard, cardTitle, tileAt, locateCardUnit, groundLike, lookChange, coveredTiles, statsOpen, identifyOnIsland }
})
