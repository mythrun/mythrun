// Layout primitives (MYT-82 Wave 1). Each impl is typed against its contract in
// @mythrun/client-core; the contract prop types are re-exported here so app code
// imports component + props from the single package root.
export { Stack } from './components/Stack/Stack.tsx'
export { Box } from './components/Box/Box.tsx'
export { Grid } from './components/Grid/Grid.tsx'
export { Divider } from './components/Divider/Divider.tsx'
// Responsive show/hide switch (MYT-87) — toggles two visually distinct layouts at
// a breakpoint (the hub's desktop grid ⊕ mobile index).
export { Show } from './components/Show/Show.tsx'
// FullBleedStage (MYT-89 audit v2) — the narrow-viewport full-screen stage:
// cancels the host frame's content inset and fills the viewport below the
// header, so a pannable surface (the world-gen graph) owns the phone screen.
// Wide viewports render a plain block (desktop unchanged).
export { FullBleedStage } from './components/FullBleedStage/FullBleedStage.tsx'

// Typography primitives (MYT-82 Wave 1b).
export { Text } from './components/Text/Text.tsx'
export { Heading } from './components/Heading/Heading.tsx'
export { Link } from './components/Link/Link.tsx'
export { VisuallyHidden } from './components/VisuallyHidden/VisuallyHidden.tsx'
// Streamed prose (myth-umggn) — LLM text arriving live, with the writing caret.
export { StreamingProse } from './components/StreamingProse/StreamingProse.tsx'
// Session play-screen (MYT-92)
export { DmMessage } from './components/DmMessage/DmMessage.tsx'
export { ThinkingIndicator } from './components/ThinkingIndicator/ThinkingIndicator.tsx'

// Character creation (MYT-90).
export { LevelCard } from './components/LevelCard/LevelCard.tsx'
export { FreeformPrompt } from './components/FreeformPrompt/FreeformPrompt.tsx'
export { GuidedBuilder } from './components/GuidedBuilder/GuidedBuilder.tsx'
export { CharacterLoadingBeat } from './components/CharacterLoadingBeat/CharacterLoadingBeat.tsx'
export { PartyRoster } from './components/PartyRoster/PartyRoster.tsx'
export { CharacterSheetReveal } from './components/CharacterSheetReveal/CharacterSheetReveal.tsx'

// Leaf primitives (MYT-82 Wave 1c) — composed by the controls (Button loading,
// IconButton).
export { Icon } from './components/Icon/Icon.tsx'
export { Spinner } from './components/Spinner/Spinner.tsx'

// Controls (MYT-82 Wave 2a) — Button + IconButton, composing the Icon + Spinner
// leaves above.
export { Button } from './components/Button/Button.tsx'
export { IconButton } from './components/IconButton/IconButton.tsx'

// Text inputs (MYT-82 Wave 2b) — native <input>/<textarea>, neutral onChange.
export { Input } from './components/Input/Input.tsx'
export { TextArea } from './components/TextArea/TextArea.tsx'

// Ghost input (MYT-82) — SeamlessInput, the borderless one-question creation-flow
// field. A real native <input>/<textarea> with the box stripped (no
// border/background); the question IS the associated label; the accent baseline
// rule is the non-box focus indicator (WCAG 2.4.13). Neutral onChange(value).
export { SeamlessInput } from './components/SeamlessInput/SeamlessInput.tsx'

// Form controls (MYT-82 Wave 2c) — Select / Checkbox / Radio + RadioGroup /
// Switch. Each wraps an unstyled `radix-ui` primitive, styled with our tokens,
// behind the DOM-free contract (neutral onChange).
export { Select } from './components/Select/Select.tsx'
export { Checkbox } from './components/Checkbox/Checkbox.tsx'
export { RadioGroup, Radio } from './components/RadioGroup/RadioGroup.tsx'
export { Switch } from './components/Switch/Switch.tsx'

// Form fields (MYT-82 Wave 2d) — Label + FormField. FormField wraps a single
// control with its Label, helper/error regions, and required/invalid state,
// wired for a11y via the controls' neutral `describedBy` relationship prop.
export { Label } from './components/Label/Label.tsx'
export { FormField } from './components/FormField/FormField.tsx'

// Containers (MYT-82 Wave 3a) — Card + its header/body/footer slots. A flat
// container (1px --border-strong edge, paper surface tier, 0px radius, no
// shadow); the compound-component / slot pattern (§9).
export { Card, CardHeader, CardBody, CardFooter } from './components/Card/Card.tsx'

// CoverCard (MYT-87) — a portrait "made-object" card (fixed 3:2): a full-bleed
// cover header over an ink seam, narrative content at the top, a foot-pinned
// imprint. The campaign-hub card is a thin composition of it.
export { CoverCard } from './components/CoverCard/CoverCard.tsx'

// GhostChoiceList (MYT-89) — a borderless "paper" choice list (flat 1-bit): each
// item is a real <button> styled as a ghost (transparent, surface-hover token-swap,
// serif title + quiet sub-line + trailing ember arrow — no border/box/mark), with
// the choices framed AND separated by quiet Divider hairlines. The campaign-create
// fork.
export { GhostChoiceList } from './components/GhostChoiceList/GhostChoiceList.tsx'

// GhostHookList (MYT-89 Phase D) — a richer sibling of GhostChoiceList: the same
// borderless flat-1-bit ghost list, but each item STACKS a serif title over an
// optional quiet place line over a prose paragraph (the narrative body the compact
// GhostChoiceItem can't hold). The starting-situation pick (three opening hooks).
export { GhostHookList } from './components/GhostHookList/GhostHookList.tsx'

// WorldGenGraph (MYT-89 Phase C) — the live streaming graph shown during world
// generation: a decorative force-directed Canvas (aria-hidden — square ink glyphs by
// kind, hand-drawn links, ambient ghost-bloom churn, fine-pointer drag-to-pin) beside
// an ACCESSIBLE entity list (the a11y/keyboard/touch selection surface). The parent
// folds the SSE stream into nodes/edges props; a reduced-motion variant swaps the
// rAF churn for a static settle-to-convergence redraw.
export { WorldGenGraph } from './components/WorldGenGraph/WorldGenGraph.tsx'

// WorldGenFogField (MYT-89 Phase C, C3) — the decorative fog layer of the world-gen
// loading experience: rolling clouds that part/close around the streaming entity labels
// and fade to nothing as the graph fills. An aria-hidden canvas that sits BEHIND the
// graph canvas (§5, layered canvases); the fixed-timestep sim + crisp Bayer paint + the
// 900×470 virtual space live inside, driven by plain `FogFieldEntity[]` + fade counts.
export { WorldGenFogField } from './components/WorldGenFog/WorldGenFogField.tsx'

// WorldGenStatusCard (MYT-89 Phase C, C4 + audit ③/⑥ + the two-act cut + reveal
// timing) — the generation status/loading overlay pinned top-left of the graph pane:
// the current stage's friendly label, a completed/total percent, an optional
// data-driven "time left", and a PAPER-REGISTER segmented square bar of a FIXED cell
// count (one per canonical WATCHED_ENTITY_STAGES stage — the prep stages live in
// WorldGenLoading, the silent tail runs behind the wiki reveal; the running cell
// pulses; NO spinner/circle). A DOM overlay (§3.3) reading the stream's `stages[]` to
// advance the fills; the bars hit 100% exactly at the wiki-reveal moment. Cost is NOT
// shown (the player never sees API spend).
export { WorldGenStatusCard } from './components/WorldGenStatusCard/WorldGenStatusCard.tsx'

// WorldGenLoading (MYT-89 two-act generating flow, act one) — the generic pre-entity
// loading screen shown while the prep stages run: the DS Spinner + a flavor line
// cycling short playful loading messages, growing the "watch your world be born"
// watch button once entities start streaming (`watchReady` → `onWatch`).
export { WorldGenLoading } from './components/WorldGenLoading/WorldGenLoading.tsx'

// WorldWiki (MYT-89 Phase D) — the browsable wiki the owner explores their newly
// generated world through: a borderless search field over a grouped tree
// (factions/locations/npcs/items, nested locations indent under their parent), each
// entity opening to its facts. Flat 1-bit paper register (Divider rules between
// groups, a surface token-swap marks selection). Selection + query are prop-driven,
// so D3 can wire the graph↔wiki shared selection through `selectedId`/`onSelect`.
export { WorldWiki } from './components/WorldWiki/WorldWiki.tsx'

// RevealTransition (MYT-89 Phase D, §3.8) — the gen→reveal reward moment: the
// once-latched, skippable timeline (hold → gust → settle → resolve → done, or a
// ~300ms reduced-motion surface fade) handed to consumers as a render-prop
// `RevealMoment`; RevealPanes is the desktop full-width→50/50 arrival frame;
// RevealFade the phase-keyed whole-block opacity fade (the sanctioned motion).
// The named REVEAL_*_MS timings + the phase-order predicate ship for consumers
// that stage their own pieces (drawer mount timing, the fog's drain flip).
export {
  RevealTransition,
  RevealPanes,
  RevealFade,
  revealPhaseAtLeast,
  REVEAL_HOLD_MS,
  REVEAL_GUST_MS,
  REVEAL_SETTLE_MS,
  REVEAL_RESOLVE_MS,
  REVEAL_REDUCED_FADE_MS,
} from './components/RevealTransition/RevealTransition.tsx'

// Overlays (MYT-82 Wave 3b) — Modal / Popover / Tooltip / Tabs / Menu. Each wraps
// an unstyled `radix-ui` overlay primitive (Dialog / Popover / Tooltip / Tabs /
// DropdownMenu): Radix supplies the a11y headline (focus trap + focus-RETURN,
// keyboard nav, portals, ARIA wiring), we supply the token styling + `--z-*`
// layering. DOM-free contracts (neutral onOpenChange/onChange/onSelect). Tooltip
// ships its Provider (mount once at the app root).
export { Modal } from './components/Modal/Modal.tsx'
// Drawer (MYT-89 Phase D) — the edge-handle side sheet. Radix Dialog like Modal
// but MOUNT-PERSISTENT: children keep their state across close/open (the sheet
// slides off-screen inert; it never unmounts).
export { Drawer } from './components/Drawer/Drawer.tsx'
export { Popover } from './components/Popover/Popover.tsx'
export { Tooltip, TooltipProvider } from './components/Tooltip/Tooltip.tsx'
export { Tabs } from './components/Tabs/Tabs.tsx'
export { Menu } from './components/Menu/Menu.tsx'

// Status-intent feedback (MYT-82 Wave 3c) — Banner (inline, persistent) + the
// Toast subsystem (transient, app-global). Toast is IMPERATIVE: mount a single
// `<ToastProvider>` at the app root and call `toast(options)` from anywhere.
export { Banner } from './components/Banner/Banner.tsx'
export { ToastProvider } from './components/Toast/Toast.tsx'
export { toast } from './components/Toast/toast-store.ts'

// Identity + display (MYT-82 Wave 3d) — Avatar / AvatarGroup (Radix
// image-with-fallback; the brand's one sanctioned ROUND shape), Badge (a flat
// mono status chip), Dither (the brand's ONLY sanctioned gradient — a locked
// 4×4-Bayer two-color transition, never a smooth gradient).
export { Avatar } from './components/Avatar/Avatar.tsx'
export { AvatarGroup } from './components/Avatar/AvatarGroup.tsx'
export { Badge } from './components/Badge/Badge.tsx'
export { Dither } from './components/Dither/Dither.tsx'
// CoverDither (MYT-87) — the card-scale world-identity dither cover (a full-field
// tiled texture), distinct from Dither's fixed transition strip.
export { CoverDither } from './components/CoverDither/CoverDither.tsx'

// Brand identity suite (MYT-84 visual audit) — the four first-class brand-art
// components, each inlining its locked SVG export, theme-driven (ink on light, cream
// on dark): `Logomark` (the pixel-art mark, crisp-scaled, ink/ember tone), `Wordmark`
// (the Tyma Garamont logotype), `Lockup` (PRIMARY / stacked), `HorizontalLockup`
// (SECONDARY / mark-on-right). PLUS the OFFICIAL third-party provider marks (Google's
// 4-color "G", the Discord mark) — external brand assets (provider-mandated colors,
// not design tokens), so they live in `src/brand-marks/`, outside the token zone, but
// ship through the one package barrel like every other UI element.
export { Logomark } from './components/Logomark/Logomark.tsx'
export { Wordmark } from './components/Wordmark/Wordmark.tsx'
export { Lockup } from './components/Lockup/Lockup.tsx'
export { HorizontalLockup } from './components/HorizontalLockup/HorizontalLockup.tsx'
export { GoogleMark } from './brand-marks/GoogleMark.tsx'
export { DiscordMark } from './brand-marks/DiscordMark.tsx'

// Theme runtime (MYT-84) — the root ThemeProvider + the useTheme hook live in the
// web UI package so the ThemeToggle (and screens) can consume them.
export { ThemeProvider, useTheme } from './theme/theme-provider.tsx'
export { ThemeToggle } from './components/ThemeToggle/ThemeToggle.tsx'

// The DS's ONE narrow-viewport regime (< 640px — the exact complement of the
// `sm:` variant), exported so a screen whose narrow layout is STRUCTURAL (a
// different DOM — the reveal's wiki pane vs drawer, MYT-89 D5) flips on the
// SAME boolean the DS components (FullBleedStage, WorldGenGraph) flip on
// internally. One query, one regime — the app and the DS can never disagree.
export { useViewportNarrow } from './lib/use-viewport-narrow.ts'

export type {
  StackProps,
  BoxProps,
  GridProps,
  DividerProps,
  ShowProps,
  Breakpoint,
  FullBleedStageProps,
  SpaceToken,
  TextProps,
  TextRole,
  StreamingProseProps,
  DmMessageProps,
  ThinkingIndicatorProps,
  HeadingProps,
  HeadingLevel,
  HeadingRole,
  LinkProps,
  VisuallyHiddenProps,
  IconProps,
  IconName,
  IconSize,
  SpinnerProps,
  ButtonProps,
  ButtonVariant,
  ButtonSize,
  ButtonType,
  IconButtonProps,
  InputProps,
  InputSize,
  InputType,
  TextAreaProps,
  SeamlessInputProps,
  SelectProps,
  SelectOption,
  SelectSize,
  CheckboxProps,
  CheckedState,
  RadioProps,
  RadioGroupProps,
  SwitchProps,
  LabelProps,
  FormFieldProps,
  CardProps,
  CardHeaderProps,
  CardBodyProps,
  CardFooterProps,
  CoverCardProps,
  GhostChoiceListProps,
  GhostChoiceItem,
  GhostHookListProps,
  GhostHookItem,
  WorldGenGraphProps,
  GraphNode,
  GraphEdge,
  GraphNodeState,
  WorldGenFogFieldProps,
  FogFieldEntity,
  FogObstacle,
  WorldGenStatusCardProps,
  StageProgress,
  WorldGenLoadingProps,
  WorldWikiProps,
  WikiViewModel,
  WikiGroup,
  WikiEntity,
  WikiFact,
  RevealPhase,
  RevealMoment,
  RevealTransitionProps,
  RevealPanesProps,
  RevealFadeProps,
  ModalProps,
  DrawerProps,
  PopoverProps,
  PopoverSide,
  TooltipProps,
  TooltipProviderProps,
  TooltipSide,
  TabsProps,
  TabItem,
  MenuProps,
  MenuItem,
  MenuSide,
  BannerProps,
  Severity,
  ToastOptions,
  ToastProviderProps,
  AvatarProps,
  AvatarGroupProps,
  AvatarSize,
  BadgeProps,
  BadgeVariant,
  DitherProps,
  DitherDirection,
  PaletteColor,
  PaletteRamp,
  PaletteStep,
  CoverDitherProps,
  LogomarkProps,
  LogomarkTone,
  WordmarkProps,
  LockupProps,
  HorizontalLockupProps,
  Theme,
  ThemeContextValue,
  ThemeToggleProps,
  ThemeTogglePlacement,
} from '@mythrun/client-core/contract'
