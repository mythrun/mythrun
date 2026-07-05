import { thresholdAt } from '../Dither/bayer.ts'

// GhostBloomField — the world-gen streaming graph's ambient churn layer (the
// "B1 ghost-bloom" pick). World-gen runs ~10 minutes and named entities land
// only every ~15s; between arrivals the graph would read as dead. This helper
// fills that dead air with faint, transient 1-bit DITHER "blooms" scattered near
// the real graph's points, implying a vast world being generated just off-screen.
//
// It is PROCEDURAL atmosphere — no real data ever flows through it. It is a
// Canvas-2D rendering HELPER, NOT a React component: the sibling `WorldGenGraph`
// component (Task C4) owns the canvas, the animation loop, and the ink colour; it
// drives this field with spawn()/update()/render() each frame and shows it in
// motion in its own story. Keeping colour OUT of this helper (the caller sets
// `ctx.fillStyle` from the theme token before calling render) keeps R3 — no raw
// colour in component code — intact for a canvas surface Tailwind can't reach.
//
// Two invariants carry the design: the particle set is FIFO-CAPPED (a hard memory
// bound that must survive a 10-minute run without unbounded growth), and every
// bloom lifecycles out (age → density fade → removal). Both are unit-pinned.
//
// The dither is the brand's LOCKED formula, reused from `../Dither/bayer.ts`
// (`thresholdAt`) so the grain matches CoverDither et al.: square, stippled,
// hard-edged cells — never a soft radial glow. `Math.random` is fine here (UI
// jitter, not game dice — the ZFC/no-random rule governs MECHANICS); the RNG is
// injectable so tests are deterministic.

/** A point on the real named graph (px), in the canvas coordinate space the host
 *  draws in. Blooms cluster near these so the churn reads as "more being made
 *  nearby". */
export interface GhostBloomPoint {
  x: number
  y: number
}

/** Tunables. All optional with production-sensible defaults; a host or a test may
 *  override any (notably `random` for determinism and `cap` for the bound). */
export interface GhostBloomOptions {
  /** Reduced-motion escape hatch: spawn/update/render all become no-ops, leaving
   *  the graph static. Respect the user's prefers-reduced-motion. */
  reducedMotion?: boolean
  /** FIFO cap — the memory-safety invariant. The live set never holds more than
   *  this many blooms; spawning past it evicts the oldest. */
  cap?: number
  /** Expected blooms emitted per SECOND of elapsed `dt` (scaled by dt in spawn). */
  spawnRate?: number
  /** Milliseconds a bloom lives; update() removes it once it ages past this. */
  lifetime?: number
  /** Dither cell size in px — the square grain of each bloom. */
  cell?: number
  /** Bloom radius in cells — the stamp's half-extent. */
  radius?: number
  /** Scatter (px) around an anchor point a bloom is jittered within. */
  spread?: number
  /** Peak composite opacity of a bloom (ambient — blooms stay faint, never solid). */
  peakAlpha?: number
  /** Peak inked-cell density at a fresh bloom's centre (< 1 so even a fresh bloom
   *  stipples — paper shows through — rather than reading as a solid disc). */
  peakDensity?: number
  /** Injectable RNG in [0, 1). Defaults to Math.random. UI jitter only, not dice. */
  random?: () => number
}

/** One live bloom: its centre (px), the clock value it was born at (for ageing),
 *  and a per-bloom seed that shifts the dither so blooms don't all look alike. */
interface Bloom {
  x: number
  y: number
  bornAt: number
  seed: number
}

const DEFAULT_CAP = 300
const DEFAULT_SPAWN_RATE = 8
const DEFAULT_LIFETIME_MS = 2600
const DEFAULT_CELL_PX = 4
const DEFAULT_RADIUS_CELLS = 4
const DEFAULT_SPREAD_PX = 40
const DEFAULT_PEAK_ALPHA = 0.16
const DEFAULT_PEAK_DENSITY = 0.7

/** When no named points exist yet, emit at a fraction of the rate around the
 *  origin — a bare ambient shimmer, not the full near-graph churn. */
const AMBIENT_RATE_FACTOR = 0.25

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export class GhostBloomField {
  private blooms: Bloom[] = []
  /** The last clock value update() saw; spawn() stamps new blooms with it, and
   *  render() ages against it. Starts at 0 so a spawn-before-first-update works. */
  private now = 0

  private readonly reducedMotion: boolean
  private readonly cap: number
  private readonly spawnRate: number
  private readonly lifetime: number
  private readonly cell: number
  private readonly radius: number
  private readonly spread: number
  private readonly peakAlpha: number
  private readonly peakDensity: number
  private readonly random: () => number

  constructor(options: GhostBloomOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? false
    this.cap = options.cap ?? DEFAULT_CAP
    this.spawnRate = options.spawnRate ?? DEFAULT_SPAWN_RATE
    this.lifetime = options.lifetime ?? DEFAULT_LIFETIME_MS
    this.cell = options.cell ?? DEFAULT_CELL_PX
    this.radius = options.radius ?? DEFAULT_RADIUS_CELLS
    this.spread = options.spread ?? DEFAULT_SPREAD_PX
    this.peakAlpha = options.peakAlpha ?? DEFAULT_PEAK_ALPHA
    this.peakDensity = options.peakDensity ?? DEFAULT_PEAK_DENSITY
    this.random = options.random ?? Math.random
  }

  /** Live bloom count — the FIFO-capped set size. */
  get count(): number {
    return this.blooms.length
  }

  /**
   * Probabilistically emit faint blooms near the named graph's points, at a rate
   * scaled by `dt` (ms since the last frame). Empty `nearPoints` still drips a
   * subtle ambient shimmer around the origin. A non-positive `dt` (or reduced
   * motion) is a no-op.
   */
  spawn(dt: number, nearPoints: readonly GhostBloomPoint[]): void {
    if (this.reducedMotion || dt <= 0) return
    const hasPoints = nearPoints.length > 0
    const rate = hasPoints ? this.spawnRate : this.spawnRate * AMBIENT_RATE_FACTOR
    // Expected emissions this frame. The integer part always fires; the
    // fractional remainder fires with matching probability (a cheap Poisson-ish
    // draw) so low per-frame rates still average out correctly over time.
    let budget = rate * (dt / 1000)
    while (budget > 0) {
      if (budget >= 1 || this.random() < budget) this.emit(nearPoints)
      budget -= 1
    }
  }

  /** Emit one bloom jittered around an anchor (a random named point, or the
   *  origin when none exist), pushing past the cap evicts the oldest (FIFO). */
  private emit(nearPoints: readonly GhostBloomPoint[]): void {
    const anchor = this.pickAnchor(nearPoints)
    this.blooms.push({
      x: anchor.x + this.jitter(),
      y: anchor.y + this.jitter(),
      bornAt: this.now,
      seed: Math.floor(this.random() * 997),
    })
    if (this.blooms.length > this.cap) this.blooms.shift()
  }

  /** A random named point to cluster near, or the origin when the graph has none
   *  yet (the ambient-drift case — the host can translate the context to place it). */
  private pickAnchor(nearPoints: readonly GhostBloomPoint[]): GhostBloomPoint {
    if (nearPoints.length === 0) return { x: 0, y: 0 }
    const index = Math.min(nearPoints.length - 1, Math.floor(this.random() * nearPoints.length))
    return nearPoints[index] ?? { x: 0, y: 0 }
  }

  /** Symmetric px offset in [-spread, +spread] for scatter around an anchor. */
  private jitter(): number {
    return (this.random() * 2 - 1) * this.spread
  }

  /**
   * Advance the clock to `t` (ms) and remove every bloom that has aged past its
   * lifetime. Reduced motion is a no-op (the set stays empty, never touched).
   */
  update(t: number): void {
    if (this.reducedMotion) return
    this.now = t
    this.blooms = this.blooms.filter((b) => t - b.bornAt < this.lifetime)
  }

  /**
   * Draw every live bloom as a faint 1-bit dither stamp that thins with age.
   * The caller sets `ctx.fillStyle` (the theme ink) before calling; we only
   * modulate `globalAlpha` and paint hard square cells. Wrapped in save/restore
   * so the caller's canvas state is untouched. Reduced motion draws nothing.
   */
  render(ctx: CanvasRenderingContext2D): void {
    if (this.reducedMotion) return
    ctx.save()
    ctx.globalAlpha = this.peakAlpha
    for (const bloom of this.blooms) this.renderBloom(ctx, bloom)
    ctx.restore()
  }

  /** Paint one bloom: a stippled disc of Bayer-thresholded square cells whose
   *  inked density falls off toward the rim AND with age, so an old bloom
   *  dissolves to nothing rather than vanishing in one frame. */
  private renderBloom(ctx: CanvasRenderingContext2D, bloom: Bloom): void {
    const life = clamp01(1 - (this.now - bloom.bornAt) / this.lifetime)
    if (life <= 0) return
    const r = this.radius
    const baseCol = Math.round(bloom.x / this.cell)
    const baseRow = Math.round(bloom.y / this.cell)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.hypot(dx, dy)
        if (dist > r) continue
        const density = life * (1 - dist / r) * this.peakDensity
        const col = baseCol + dx
        const row = baseRow + dy
        // The LOCKED brand dither (Bayer + chaos), shifted per bloom by its seed
        // so neighbouring blooms don't share a grid. A cell inks when its
        // threshold falls under the local density → square, stippled, hard-edged.
        if (thresholdAt(col + bloom.seed, row) < density) {
          ctx.fillRect(col * this.cell, row * this.cell, this.cell, this.cell)
        }
      }
    }
  }
}
