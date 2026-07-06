// Fog physics — the LOCKED params + every internal constant, ported for the
// world-gen "fog + entities" render (MYT-89 Phase C, Task C1).
//
// Sole authority: docs/superpowers/specs/assets/2026-07-05-worldgen-fog-reference.html.
// Every constant is copied verbatim; do not re-derive.
//
// This is a pure-data module (no DOM, no math beyond the reference's own /16
// Bayer normalization). Task C2's `FogSim` fluid core consumes these; C3/C4
// consume the render-side constants. The reference is a self-contained
// <canvas> prototype Miklos dialed in by eye over a full day — any drift from
// its numbers is a bug. Where a value belongs to a runtime slider its LOCKED
// default lives in `FOG_PARAMS`; its full tuning envelope in `FOG_PARAM_RANGES`.
//
// The parenthetical "(ref: …)" notes point at the exact expression in the
// prototype so a future reader can diff a constant back to its source line.

// ──────────────────────────────────────────────────────────────────────────
// Virtual coordinate space (spec §3.6)
// The reference canvas is 900×470 in CSS px; that IS the virtual coordinate
// space C2/C3 render in, then CSS-scale to the host. `GW`/`GH` (the density
// grid dims) are DERIVED at runtime as `Math.ceil(W/CELL)` / `Math.ceil(H/CELL)`
// — not exported, since they follow from these three.
// ──────────────────────────────────────────────────────────────────────────

/** ref: `W=900`. Virtual canvas width (px). */
export const VIRTUAL_WIDTH = 900

/** ref: `H=470`. Virtual canvas height (px). */
export const VIRTUAL_HEIGHT = 470

/** ref: `DPR=Math.min(2,window.devicePixelRatio||1)`. Device-pixel-ratio cap for
 *  the backing store — never render above 2× regardless of the display. */
export const DPR_CAP = 2

// ──────────────────────────────────────────────────────────────────────────
// Density grid
// ──────────────────────────────────────────────────────────────────────────

/** ref: `CELL=6`. Density-grid / fog-quad cell size (px). */
export const CELL_PX = 6

/** ref: `cloud(gx*CELL+3, gy*CELL+3, …)`. Sample offset to a cell's CENTRE when
 *  evaluating the cloud field (= CELL_PX / 2). */
export const CELL_CENTER_PX = 3

// ──────────────────────────────────────────────────────────────────────────
// Particle field
// ──────────────────────────────────────────────────────────────────────────

/** ref: `N=4800`. Base particle count. C2 AREA-SCALES this to the real render
 *  size — the prototype tuned it at the 900×470 virtual space. */
export const PARTICLE_COUNT = 4800

/** ref: `P=new Float32Array(N*4)`. Floats per particle: `[x, y, vx, vy]`. */
export const PARTICLE_STRIDE = 4

/** ref: `BND=16`. Off-canvas band (px): particles spawn just outside this band
 *  (`-BND` / `W+BND`) and are respawned once they drift past it. */
export const SPAWN_BOUND_PX = 16

// ──────────────────────────────────────────────────────────────────────────
// Wind
// ref: `WIND=[-1.75,0.9]`. The base wind direction (blows down-and-left). At
// runtime it is scaled by the `wind` slider: `wx=WIND[0]*SPEED, wy=WIND[1]*SPEED`.
// The spawn edge-split weights (`Math.abs(WIND[1])*W` top vs `Math.abs(WIND[0])*H`
// right) are DERIVED from this vector, not separate constants.
// ──────────────────────────────────────────────────────────────────────────

/** ref: `WIND=[-1.75,0.9]`. Base wind vector `[x, y]`, pre-`wind`-slider. */
export const WIND_BASE = [-1.75, 0.9] as const

// ──────────────────────────────────────────────────────────────────────────
// Bayer dither + chaos hash (fog-quad threshold)
// The fog paints a cell when its coverage clears an ordered-Bayer threshold
// blended with a pseudo-random "chaos" term — the brand dither formula. This is
// numerically identical to @mythrun/ui's `Dither/bayer.ts` `BAYER_4X4`; a future
// C3 render consolidation MAY reuse that module, but client-core cannot import
// from @mythrun/ui (dependency direction is ui→client-core), so the fog carries
// its own verbatim copy from the reference.
// ──────────────────────────────────────────────────────────────────────────

/** ref: `[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]]` (pre-normalization).
 *  The standard 4×4 ordered Bayer threshold matrix, raw 0–15 integers. */
export const BAYER_16: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/** ref: `…​.map(r=>r.map(v=>v/16))`. The Bayer matrix normalized to [0, 1) — the
 *  form the fog threshold indexes as `BAYER[gy%4][gx%4]`. */
export const BAYER: readonly (readonly number[])[] = BAYER_16.map((row) =>
  row.map((v) => v / 16),
)

/** ref: `Math.sin(cx*127.1+cy*311.7)*43758.5453; return s-Math.floor(s)`. The
 *  classic GLSL fract-sin hash — a stable per-cell pseudo-random value in [0, 1)
 *  that breaks the ordered Bayer grid. */
export const CHAOS_HASH = {
  xCoeff: 127.1,
  yCoeff: 311.7,
  scale: 43758.5453,
} as const

/** ref: `cov>0.85*BAYER[…]+0.15*chaos(…)`. Threshold blend weights: 85% ordered
 *  Bayer + 15% chaos (matches the brand dither 0.85 / 0.15). */
export const DITHER_ORDERED_WEIGHT = 0.85
export const DITHER_CHAOS_WEIGHT = 0.15

// ──────────────────────────────────────────────────────────────────────────
// Turbulence (base velocity perturbation)
// ref: `turb(px,py,t){const k=0.008,a=k*px,b=k*py; return [
//   sin(a + t*0.4) * cos(1.3*b - t*0.3) * 0.4,      // x component
//   cos(1.2*a - t*0.35) * sin(b + t*0.4) * 0.4 ];}  // y component
// ──────────────────────────────────────────────────────────────────────────

export const TURBULENCE = {
  /** `k` — spatial frequency: `a=k*px, b=k*py`. */
  k: 0.008,
  /** trailing `*0.4` on both components — perturbation amplitude. */
  amp: 0.4,
  /** x component: `sin(a + t*timeFreqA) * cos(spatialMulB*b - t*timeFreqB)`. */
  x: { timeFreqA: 0.4, spatialMulB: 1.3, timeFreqB: 0.3 },
  /** y component: `cos(spatialMulA*a - t*timeFreqA) * sin(b + t*timeFreqB)`. */
  y: { spatialMulA: 1.2, timeFreqA: 0.35, timeFreqB: 0.4 },
} as const

// ──────────────────────────────────────────────────────────────────────────
// Doublet (dipole) wake — the label-avoidance field
// Each label becomes a line of "doublet" points the fog streams around. ref:
// field() lines. `RD` is the doublet radius; `RD2 = RD*RD`. Per point:
//   r2 = max(dx²+dy², RD2);  a = dx·ŵ + dy·ŵ⊥;  b = -dx·ŵ⊥ + dy·ŵ;
//   c = U·RD2 / r2²;  up = -c·(a² - b²);  vp = -2·c·a·b   (rotated back to xy)
// ──────────────────────────────────────────────────────────────────────────

/** ref: `RD=13` (and `RD2=RD*RD`). Doublet radius (px). */
export const DOUBLET_RADIUS_PX = 13

/** ref: `K=Math.max(2,Math.round(len/24))`. Doublet points are spaced ~every 24px
 *  along a label capsule, minimum 2 points. */
export const DOUBLET_SPACING_PX = 24
export const DOUBLET_MIN_POINTS = 2

/** ref: `vp=-2*c*a*b`. Coefficient on the cross term of the doublet velocity
 *  (the along-wind `up` term's coefficient is the implicit -1). */
export const DOUBLET_VP_COEFF = 2

/** Wake "close" — the plume the fog draws BACK together downstream of a label.
 *  ref: `if(CLOSE>0 && a>1.6*RD){ g=CLOSE*U*exp(-a/(6*RD))*exp(-b*b/(18*RD2));
 *  perp=-(b/(2*RD))*g; … }`. `CLOSE` is the runtime `close` slider. */
export const WAKE_CLOSE = {
  /** `a > 1.6*RD` — only acts downstream of the doublet. */
  gateRdMul: 1.6,
  /** `exp(-a / (6*RD))` — along-wind decay. */
  decayA_RdMul: 6,
  /** `exp(-b*b / (18*RD2))` — cross-wind decay. */
  decayB_Rd2Mul: 18,
  /** `-(b / (2*RD))` — cross-wind perpendicular strength. */
  perpRdMul: 2,
} as const

/** Velocity DRAG — a label's own motion drags nearby fog with it (so a dragged
 *  node's wake follows). ref: `if(r2<9*RD2){ w=1-sqrt(r2)/(3*RD);
 *  vx+=d[2]*w*0.7; vy+=d[3]*w*0.7; }` — `d[2]/d[3]` are the point's vx/vy. */
export const WAKE_DRAG = {
  /** `r2 < 9*RD2` — influence radius (= (3·RD)²). */
  radiusRd2Mul: 9,
  /** `1 - sqrt(r2)/(3*RD)` — linear falloff to the edge. */
  falloffRdMul: 3,
  /** trailing `*0.7` — fraction of the label's velocity imparted. */
  coeff: 0.7,
} as const

// ──────────────────────────────────────────────────────────────────────────
// Forcefield (hard entity exclusion)
// ref: `EXR=12+MARGIN`, then `if(d<EXR){X+=nx*(EXR-d);Y+=ny*(EXR-d);}`. A hard
// keep-out radius around each label capsule (`MARGIN` is the runtime slider).
// ──────────────────────────────────────────────────────────────────────────

/** ref: `EXR=12+MARGIN`. Base exclusion radius (px), before the `margin` slider. */
export const FORCEFIELD_BASE_PX = 12

// ──────────────────────────────────────────────────────────────────────────
// Cloud modulation (multi-octave wind-scrolled sinus field)
// ref: cloud(px,py,wx,wy,t){ sx=px-wx*60*t; sy=py-wy*60*t;
//   n = sin(sx*0.0098 + sy*0.006  + t*0.1)
//     + 0.6*sin(sx*0.020  - sy*0.016 + 2.1)
//     + 0.4*sin(sx*0.038  + sy*0.031 - 1.3);
//   return max(0, 0.5 + 0.78*(n/2)); }
// ──────────────────────────────────────────────────────────────────────────

/** ref: `sx=px-wx*60*t`. Wind-scroll rate — the cloud field advects with the
 *  wind at 60× the scaled wind vector per second. */
export const CLOUD_WIND_SCROLL = 60

/** The three sinus octaves. `fx`/`fy` are spatial frequencies on the wind-scrolled
 *  coords, `amp` the octave weight, `phase` the added phase, `timeFreq` the `t`
 *  coefficient (only the first octave animates in time; the other two are 0). */
export const CLOUD_OCTAVES = [
  { fx: 0.0098, fy: 0.006, amp: 1, phase: 0, timeFreq: 0.1 },
  { fx: 0.02, fy: -0.016, amp: 0.6, phase: 2.1, timeFreq: 0 },
  { fx: 0.038, fy: 0.031, amp: 0.4, phase: -1.3, timeFreq: 0 },
] as const

/** ref: `return Math.max(0, 0.5 + 0.78*(n/2))`. Contrast curve over the summed
 *  octaves `n`: `base + gain * (n / normDivisor)`, floored at 0. */
export const CLOUD_CONTRAST_BASE = 0.5
export const CLOUD_CONTRAST_GAIN = 0.78
export const CLOUD_NORM_DIVISOR = 2

// ──────────────────────────────────────────────────────────────────────────
// Coverage → paint
// ref: `cov=(pd/0.30)*cloud(…)*EFF`. Smoothed density `pd` is normalized by this
// divisor before the cloud + effective-density multipliers.
// ──────────────────────────────────────────────────────────────────────────

/** ref: `pd/0.30`. Density normalization divisor for the paint coverage. */
export const COVERAGE_DIVISOR = 0.3

/** ref: `dens[…]+=(ox|oy)?((ox&&oy)?0.0625:0.125):0.25`. The 3×3 particle splat
 *  kernel: centre cell / 4-neighbour edge / diagonal corner weights. */
export const SPLAT_KERNEL = {
  center: 0.25,
  edge: 0.125,
  corner: 0.0625,
} as const

/** ref: `dsm[k]+=(dens[k]-dsm[k])*STEADY`. Temporal smoothing — this is the
 *  default; `STEADY` is the runtime `steady` slider (see `FOG_PARAMS.steady`). */
export const TEMPORAL_SMOOTHING_DEFAULT = 0.03

// ──────────────────────────────────────────────────────────────────────────
// Fade curve ("fade fog as the graph fills")
// ref: `EFF = FADE ? DENSITY*Math.pow(1 - NSHOWN/NMAX, 0.85) : DENSITY`. With
// fade on, density scales toward zero as the graph fills. `NMAX` is the live
// entity count, not a constant — only the exponent is.
// ──────────────────────────────────────────────────────────────────────────

/** ref: `Math.pow(1 - NSHOWN/NMAX, 0.85)`. Fade curve exponent. */
export const FADE_EXPONENT = 0.85

// ──────────────────────────────────────────────────────────────────────────
// Entity markers + label buoy-bob
// ──────────────────────────────────────────────────────────────────────────

/** ref: `e.sz = e.k==='FACTION'?12 : e.k==='NPC'?9 : 11`. Marker size (px) by
 *  entity kind; LOCATION/ITEM (and any other) take `DEFAULT`. */
export const ENTITY_SIZE = {
  FACTION: 12,
  NPC: 9,
  DEFAULT: 11,
} as const

/** ref: `x.rotate(Math.PI/4)` (NPC branch). NPCs render as a 45°-rotated square
 *  (a diamond) — the shape-differentiation that replaces colour-by-type. */
export const NPC_ROTATION_RAD = Math.PI / 4

/** Entity buoy-bob — a gentle idle sway on each label so the graph breathes.
 *  ref: `ph = e.x*0.021 + e.y*0.017;
 *    ex = e.x + sin(t*0.9 + ph)*1.2 + sin(t*1.7 + ph*1.3)*0.5;
 *    ey = e.y + sin(t*1.15 + ph*0.8)*2.4 + cos(t*0.7 + ph)*0.8;` */
export const BUOY_BOB = {
  /** `ph = x*xCoeff + y*yCoeff` — a per-position phase so labels desync. */
  phase: { xCoeff: 0.021, yCoeff: 0.017 },
  /** x offset: sum of two `sin` terms `sin(t*timeFreq + ph*phaseMul)*amp`. */
  x: [
    { timeFreq: 0.9, phaseMul: 1, amp: 1.2 },
    { timeFreq: 1.7, phaseMul: 1.3, amp: 0.5 },
  ],
  /** y offset: a `sin` term + a `cos` term `fn(t*timeFreq + ph*phaseMul)*amp`. */
  y: [
    { fn: 'sin', timeFreq: 1.15, phaseMul: 0.8, amp: 2.4 },
    { fn: 'cos', timeFreq: 0.7, phaseMul: 1, amp: 0.8 },
  ],
} as const

/** ref: `if(i===drag){ e.x+=(mx-e.x)*0.45; e.y+=(my-e.y)*0.45; }`. Drag-follow
 *  lerp factor when a label is being dragged (interactive prototype). */
export const ENTITY_DRAG_LERP = 0.45

/** ref: `if(best<32){ drag=bi; … }` (pointerdown). Max pointer-to-capsule distance
 *  (px) that grabs a label for dragging (interactive prototype). */
export const POINTER_GRAB_PX = 32

/** ref: `e.x=Math.max(16,Math.min(W-16,e.x)); e.y=Math.max(20,Math.min(H-26,e.y))`.
 *  Insets (px) that keep a label on-canvas. */
export const ENTITY_CLAMP = {
  xInset: 16,
  yTop: 20,
  yBottom: 26,
} as const

/** ref: `caps = e => [e.x-e.sz/2, e.y-3, e.x+e.sz+e.tw, e.y-3]`. The label
 *  "capsule" (the segment the doublet points + forcefield are built along) sits
 *  this many px ABOVE the marker anchor. Horizontal span is derived from marker
 *  size + measured text width (`sz`/`tw`), not a literal. */
export const LABEL_CAP_Y_OFFSET = 3

/** ref: `gx0=(e.x-e.sz/2-2)/CELL … gx1=(e.x+e.sz+e.tw+2)/CELL,
 *  gy0=(e.y-16)/CELL … gy1=(e.y+9)/CELL`. Padding (px) of the box in which the
 *  smoothed density is force-cleared to 0 behind a label (so fog never covers
 *  the text). `x` pads both sides; `yTop`/`yBottom` bound it vertically. */
export const LABEL_CLEAR_PAD = {
  x: 2,
  yTop: 16,
  yBottom: 9,
} as const

/** ref: `x.fillText(e.n, ex+sz, ey+5)`. Label text baseline offset from the
 *  bobbed marker: `x` is `+sz` (the marker size, derived); `y` is this literal. */
export const LABEL_TEXT_Y_OFFSET = 5

/** ref: `x.font='14px Georgia,serif'`. Marker-label font (prototype render). */
export const LABEL_FONT = '14px Georgia,serif'

// ──────────────────────────────────────────────────────────────────────────
// Streamlines (debug overlay — the "streamlines" toggle)
// ref: frame() LINES branch. Seeds a rake of streamlines from the right edge and
// integrates them through the field; a diagnostic view of the flow, not part of
// the shipped fog paint.
// ──────────────────────────────────────────────────────────────────────────

export const STREAMLINES = {
  /** `x.strokeStyle='rgba(90,82,60,0.28)'`. */
  stroke: 'rgba(90,82,60,0.28)',
  /** `x.lineWidth=1`. */
  lineWidth: 1,
  /** `for(let sy=18; sy<H; sy+=26)` — seed rows: first row / row spacing (px). */
  seedStartY: 18,
  seedStepY: 26,
  /** `let px=W-6` — seed x inset from the right edge (px). */
  seedInsetX: 6,
  /** `for(let s=0; s<80; s++)` — integration steps per streamline. */
  steps: 80,
  /** `px+=vx*1.4; py+=vy*1.4` — integration step scale. */
  stepScale: 1.4,
  /** `if(px<-20||py<-20||py>H+20)break` — off-canvas cull margin (px). */
  cullMargin: 20,
} as const

// ──────────────────────────────────────────────────────────────────────────
// LOCKED runtime defaults — Miklos's dialed-in "copy settings for Claude" output
// (task brief step 2). The five numeric sliders match the reference `value=`
// attributes verbatim; `entities` is the reference's initial `NSHOWN=4`.
//
// NOTE — `fadeAsGraphFills`: the brief's LOCKED list pins fade ON, and the whole
// reference is built around "fade the fog as the graph fills" (its title). The
// reference's raw INITIAL toggle state is OFF (`let FADE=0`, flipped by the
// button), but that is a prototype start-state, not a tuned default — the LOCKED
// configuration is fade ON. Flagged in the C1 report.
//
// NOTE — colours: hex uses the reference's own lowercase form (`#a89f8a` /
// `#231b12`, the `<input type=color>` `value=` attributes); the brief spells
// them uppercase but the value is identical.
// ──────────────────────────────────────────────────────────────────────────

export const FOG_PARAMS = {
  /** ref: `<input id=wind value="0.35">`. Wind SPEED multiplier. */
  wind: 0.35,
  /** ref: `<input id=dens value="0.40">`. Fog density (starting thickness when
   *  fade is on). */
  density: 0.4,
  /** ref: `<input id=close value="0.1">`. Wake-close strength. */
  close: 0.1,
  /** ref: `<input id=marg value="10">`. Extra forcefield margin (px). */
  margin: 10,
  /** ref: `<input id=steady value="0.03">`. Temporal smoothing rate. */
  steady: 0.03,
  /** ref: `<input id=ents value="4">` / `let NSHOWN=4`. Initially-shown entities. */
  entities: 4,
  /** brief LOCKED list "fade ON" (reference initial toggle is OFF — see NOTE). */
  fadeAsGraphFills: true,
  /** ref: `<input id=fogc value="#a89f8a">`. Fog fill colour. */
  fogColor: '#a89f8a',
  /** ref: `x.globalAlpha=0.5` (fog paint). Fog fill alpha. */
  fogAlpha: 0.5,
  /** ref: `#231b12` — the `loc`/`npc`/`fac`/`item` colour defaults + the
   *  `tc[e.k]||'#231b12'` fallback. The single entity ink. */
  entityInk: '#231b12',
  /** brief: "entity kind = shape-differentiated (no color-by-type)". All four
   *  kind colours default to `entityInk`; kind is conveyed by SHAPE (NPC diamond
   *  vs square), not colour. `mono()` is the locked state. */
  colorByType: false,
} as const

// ──────────────────────────────────────────────────────────────────────────
// Tunable envelopes — the slider `min`/`max`/`step` for each runtime param.
// ref: the `<input type=range>` attributes. The clamp/step range C2 exposes if
// it surfaces the sliders; `FOG_PARAMS` above holds the default within each.
// ──────────────────────────────────────────────────────────────────────────

export const FOG_PARAM_RANGES = {
  wind: { min: 0.3, max: 2.5, step: 0.05 },
  density: { min: 0.2, max: 1.4, step: 0.05 },
  close: { min: 0, max: 3, step: 0.1 },
  margin: { min: 0, max: 30, step: 1 },
  steady: { min: 0.03, max: 0.6, step: 0.01 },
  entities: { min: 0, max: 12, step: 1 },
} as const
