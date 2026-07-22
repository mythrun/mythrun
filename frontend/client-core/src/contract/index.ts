import type { ReactNode } from 'react'

/**
 * Base props shared by every mythrunUI component. Platform-neutral: no DOM types.
 * Ref forwarding is handled per-component (each component's props type adds its own ref);
 * components never expose className/style/CSSProperties/DOM event handlers.
 */
export interface BaseProps {
  children?: ReactNode
  'data-testid'?: string
}

// Layout-primitive contracts (MYT-82 Wave 1). Type-only re-exports — the barrel
// stays free of runtime values (asserted by contract.test.ts).
export type { SpaceToken } from './space-token.ts'
export type { StackProps } from './stack.ts'
export type { BoxProps } from './box.ts'
export type { GridProps } from './grid.ts'
export type { DividerProps } from './divider.ts'
// Responsive show/hide switch (MYT-87) — `above`/`below` a named breakpoint.
export type { ShowProps, Breakpoint } from './show.ts'
// Narrow-viewport full-screen stage (MYT-89 audit v2) — cancels the host frame's
// content inset and fills the viewport below the header on phone-class viewports.
export type { FullBleedStageProps } from './full-bleed-stage.ts'

// Typography-primitive contracts (MYT-82 Wave 1b).
export type { TextProps, TextRole } from './text.ts'
// Streamed prose (myth-umggn) — LLM text arriving live, with the writing caret.
export type { StreamingProseProps } from './streaming-prose.ts'
export type { HeadingProps, HeadingLevel, HeadingRole } from './heading.ts'
export type { LinkProps } from './link.ts'
export type { VisuallyHiddenProps } from './visually-hidden.ts'

// Leaf-primitive contracts (MYT-82 Wave 1c) — Icon + Spinner, composed by the
// controls (Button loading, IconButton).
export type { IconProps, IconName, IconSize } from './icon.ts'
export type { SpinnerProps } from './spinner.ts'

// Control contracts (MYT-82 Wave 2a) — Button + IconButton. These compose the
// Icon + Spinner leaves; the contracts stay DOM-free (`onPress`, no className).
export type { ButtonProps, ButtonVariant, ButtonSize, ButtonType } from './button.ts'
export type { IconButtonProps } from './icon-button.ts'

// Text-input contracts (MYT-82 Wave 2b) — Input + TextArea. Native form
// controls, but DOM-free here: the neutral `onChange(value)` (§9), no
// className/style/raw DOM events.
export type { InputProps, InputSize, InputType } from './input.ts'
export type { TextAreaProps } from './text-area.ts'

// Ghost-input contract (MYT-82) — SeamlessInput, the borderless one-question
// creation-flow field. A real native <input>/<textarea> with the box stripped
// (no border/background); the question IS the associated label. DOM-free here:
// the neutral `onChange(value)` (§9), no className/style/raw DOM events.
export type { SeamlessInputProps } from './seamless-input.ts'

// Form-control contracts (MYT-82 Wave 2c) — Select / Checkbox / Radio /
// RadioGroup / Switch. These wrap the unstyled `radix-ui` primitives in the web
// impl, styled with our tokens; the contracts stay DOM-free (neutral
// `onChange(value|checked)`, no className/style/raw DOM events). The native impl
// swaps `rn-primitives` (same API) behind the same contract.
export type { SelectProps, SelectOption, SelectSize } from './select.ts'
export type { CheckboxProps, CheckedState } from './checkbox.ts'
export type { RadioProps, RadioGroupProps } from './radio.ts'
export type { SwitchProps } from './switch.ts'

// Form-field contracts (MYT-82 Wave 2d) — Label + FormField. FormField wraps a
// single control, supplies the Label (associated to it), helper/error regions,
// and required/invalid state, all wired for a11y via the controls' neutral
// `describedBy` relationship prop. DOM-free: i18n keys, no className/style.
export type { LabelProps } from './label.ts'
export type { FormFieldProps } from './form-field.ts'

// Container contracts (MYT-82 Wave 3a) — Card + its header/body/footer slots.
// The compound-component / slot pattern (§9): `Card` is a neutral flat
// container (1px `--border-strong` edge, paper surface tier, 0px radius, no
// shadow); the slots are token-padded regions with `--border` dividers.
export type {
  CardProps,
  CardHeaderProps,
  CardBodyProps,
  CardFooterProps,
} from './card.ts'

// CoverCard (MYT-87) — a portrait "made-object" card: a full-bleed cover header
// (a CoverDither) over an ink seam, then a body with narrative content at the top
// and a foot-pinned imprint. Fixed 3:2 geometry the neutral Card doesn't model.
export type { CoverCardProps } from './cover-card.ts'

// GhostChoiceList (MYT-89) — a borderless "paper" choice list (flat 1-bit): each
// item is a real <button> styled as a ghost (transparent, surface-hover token-swap,
// serif title + quiet sub-line, no border/box/mark), with the choices framed AND
// separated by quiet Divider hairlines. The campaign-create fork. DOM-free (§9):
// each item's `onSelect` is a neutral callback, no className/style/raw DOM events.
export type { GhostChoiceListProps, GhostChoiceItem } from './ghost-choice-list.ts'

// GhostHookList (MYT-89 Phase D) — a richer sibling of GhostChoiceList: the same
// borderless flat-1-bit ghost list, but each item STACKS a serif title over an
// optional quiet place line over a prose paragraph (the narrative body the compact
// GhostChoiceItem can't hold). The starting-situation pick (three opening hooks).
// DOM-free (§9): each item's `onSelect` is a neutral callback, no className/style.
export type { GhostHookListProps, GhostHookItem } from './ghost-hook-list.ts'

// WorldGenGraph (MYT-89 Phase C) — the live streaming graph shown during world
// generation: a force-directed Canvas (aria-hidden decorative) + an ACCESSIBLE
// entity list (the a11y/keyboard/touch surface). The `GraphNode`/`GraphEdge` model
// is re-exported here so consumers read the node shape off the contract surface.
export type { WorldGenGraphProps, GenerationA11y, GraphNode, GraphEdge, GraphNodeState } from './world-gen-graph.ts'

// WorldGenStatusCard (MYT-89 Phase C, C4 + audit ③/⑥ + the two-act cut + reveal
// timing) — the generation status/loading OVERLAY pinned top-left of the graph pane:
// the current (running) stage's friendly label, a completed/total percent, an optional
// data-driven "time left", and a PAPER-REGISTER segmented square bar of a FIXED cell
// count (one per canonical WATCHED_ENTITY_STAGES stage — the prep stages live in the
// loading screen, the silent tail runs behind the wiki reveal; the running cell
// pulses; NO spinner/circle). Reads the stream's `stages[]` (B4 `StageProgress`,
// re-exported here so a consumer reads it off the same contract surface) to advance
// the fills. Cost is NOT shown (the player never sees API spend).
export type { WorldGenStatusCardProps, StageProgress } from './world-gen-status.ts'

// WorldGenLoading (MYT-89 two-act generating flow, act one) — the generic pre-entity
// loading screen: the DS Spinner + a flavor line cycling short playful loading
// messages, growing a "watch your world be born" watch button once entities start
// streaming (the consumer flips `watchReady` and swaps views on `onWatch`).
export type { WorldGenLoadingProps } from './world-gen-loading.ts'

// WorldGenFogField (MYT-89 Phase C, C3) — the decorative fog layer BEHIND the
// streaming graph: rolling clouds that part/close around entity labels and fade to
// nothing as the graph fills. `FogFieldEntity` (the caller's plain-data label) +
// `FogObstacle` (the pre-built box, for a caller that maps entities itself) are
// re-exported here so consumers read the fog model off the same contract surface.
export type { WorldGenFogFieldProps, WorldGenCameraSource, FogFieldEntity, FogObstacle } from './world-gen-fog.ts'

// WorldWiki (MYT-89 Phase D) — the browsable wiki the owner explores their
// newly-generated world through: a home landing (search + browse-by-kind groups,
// nested locations) opening onto real entity PAGES (fact body, RELATED links,
// back-nav with scroll memory). The `Wiki*` model types are re-exported here so
// a consumer reads the model shape off the same contract surface as the props.
export type {
  WorldWikiProps,
  WikiViewModel,
  WikiGroup,
  WikiEntity,
  WikiFact,
  WikiRelatedLink,
  WikiIntroduction,
  WikiIntroReference,
} from './world-wiki.ts'

// RevealTransition (MYT-89 Phase D, §3.8) — the gen→reveal reward moment: the
// timeline orchestrator (render-prop `RevealMoment`), the desktop two-pane
// arrival frame, and the phase-keyed fade block. Plays once for the player who
// watched; skippable by construction; reduced motion = a ~300ms surface fade.
export type {
  RevealPhase,
  RevealMoment,
  RevealTransitionProps,
  RevealPanesProps,
  RevealFadeProps,
} from './reveal-transition.ts'

// Overlay contracts (MYT-82 Wave 3b) — Modal / Popover / Tooltip / Tabs / Menu.
// Each wraps an unstyled `radix-ui` overlay primitive (Dialog / Popover / Tooltip
// / Tabs / DropdownMenu) in the web impl — Radix supplies the a11y headline
// (focus trap + focus-RETURN, keyboard nav, portals, ARIA wiring), we supply the
// token styling + `--z-*` layering. The contracts stay DOM-free: neutral
// `onOpenChange`/`onChange`/`onSelect` booleans/values, i18n-key labels, no
// className/style/raw DOM events. Triggers + panel content come in as slots.
export type { ModalProps } from './modal.ts'
// Drawer (MYT-89 Phase D) — the edge-handle side sheet. Same Radix Dialog
// lineage as Modal, but MOUNT-PERSISTENT: children keep their state across
// close/open (the sheet slides off-screen, it never unmounts).
export type { DrawerProps } from './drawer.ts'
export type { PopoverProps, PopoverSide } from './popover.ts'
export type { TooltipProps, TooltipProviderProps, TooltipSide } from './tooltip.ts'
export type { TabsProps, TabItem } from './tabs.ts'
export type { MenuProps, MenuItem, MenuSide } from './menu.ts'

// Status-intent feedback contracts (MYT-82 Wave 3c) — Banner (inline, persistent)
// + Toast (transient, app-global). Both share the `Severity` intent union. The
// `--surface/border/text-{severity}` token triad carries the icon + accent only;
// body text is always `--ink` (§4). Banner's role is status (success/info) vs
// alert (warning/danger); the Toast subsystem is imperative — `toast()` + a root
// `ToastProvider` whose viewport is a pre-existing live region. The `toast()`
// function is a RUNTIME value, so it ships from the UI package, not this barrel.
export type { BannerProps, Severity } from './banner.ts'
export type { ToastOptions, ToastProviderProps } from './toast.ts'

// Identity + display contracts (MYT-82 Wave 3d) — Avatar / AvatarGroup, Badge,
// Dither. Avatar wraps `radix-ui`'s Avatar (image-with-fallback) behind a
// DOM-free contract; Badge is a flat mono status chip; Dither is the brand's
// ONLY sanctioned gradient (a locked 4×4-Bayer two-color transition, never a
// smooth gradient) and takes its colors as a sanctioned token `pairing`, not raw
// colors. All DOM-free (§9): no className/style/raw DOM events.
export type { AvatarProps, AvatarGroupProps, AvatarSize, AvatarColor } from './avatar.ts'
export type { BadgeProps, BadgeVariant } from './badge.ts'
// Dither now takes its two colors as `from`/`to` PALETTE TOKEN names (the closed
// `PaletteColor` set), replacing the old fixed `pairing` presets — a consumer can
// match any adjacent section's exact palette color, still constrained to the tokens.
export type { DitherProps, DitherDirection, PaletteColor, PaletteRamp, PaletteStep } from './dither.ts'
// CoverDither (MYT-87) — the card-scale world-identity dither cover. Unlike Dither
// (a fixed transition strip), this is a FULL-FIELD tiled texture filling its host;
// its two ends are `WorldColor`s (the curated cover set), resolved to the right
// css-var namespace by `worldColorCssVar` in `@mythrun/contract`.
export type { CoverDitherProps } from './cover-dither.ts'

// Brand identity suite (MYT-84 visual audit) — the four brand-art components, each
// inlining its locked SVG export, theme-driven via `currentColor`/the `--ink` token
// (ink on light, cream on dark). DOM-free (§9): a neutral `size` height + an i18n
// `aria-label`, no className/style. `Lockup` = PRIMARY (stacked); `HorizontalLockup`
// = SECONDARY (mark-on-right); `Wordmark` = the logotype; `Logomark` = the pixel-art
// mark (crisp-scaled), with an ink/ember `tone`.
export type { LockupProps } from './lockup.ts'
export type { HorizontalLockupProps } from './horizontal-lockup.ts'
export type { WordmarkProps } from './wordmark.ts'
export type { LogomarkProps, LogomarkTone } from './logomark.ts'

// Theme contract (MYT-84) — the theme union, the `useTheme()` context value, and
// the ThemeToggle FAB props. DOM-free types; the runtime (the `<html>.dark` +
// localStorage side effects) lives in the web UI package (@mythrun/ui).
export type {
  Theme,
  ThemeContextValue,
  ThemeToggleProps,
  ThemeTogglePlacement,
} from './theme.ts'

// Character-creation contracts (MYT-90) — the DOM-free prop + shared view-model
// vocabulary for the whole character-creation frontend. The six @mythrun/ui character
// components import their props from here; the B4 view-model produces objects of the
// shared shapes (`CuratedSheet`/`FullSheet`/`LoadingBeat`/`RosterMember`/`GuidedChoice`
// …). The SRD `ClassName` is re-exported through the same surface so the guided
// builder reads its class identity off the contract, not a second import. All
// type-only (§9): pure data + neutral callbacks, no React/DOM types.
export type {
  ClassName,
  GuidedStep,
  GuidedChoice,
  GuidedOption,
  RailStep,
  LoadingBeat,
  AbilityAbbrev,
  AbilityTile,
  SheetStat,
  SheetEntry,
  SheetSkill,
  CuratedSheet,
  FullSheet,
  RosterStatus,
  RosterMember,
  CharacterLevel,
  LevelCardProps,
  FreeformPromptProps,
  GuidedBuilderLabels,
  GuidedBuilderProps,
  CharacterLoadingBeatProps,
  GuidedRailProps,
  SituationRecapProps,
  CharacterSheetRevealLabels,
  CharacterSheetRevealProps,
  PartyRosterLabels,
  PartyRosterProps,
} from './character/index.ts'

// Session play-screen prop contracts (MYT-92) — the @mythrun/ui component
// surface for the chat core. TranscriptItem re-exports the session reducer's
// item union (the wave-2 rendering contract). MYT-93 appends the dice-moment
// surface: the reveal view-model shapes (CardItem / RollPhase / RollRevealView)
// and the RollCard / DieSpin prop contracts (RollCardProps / RollCardLabels /
// DieSpinProps) — all type-only, keeping this barrel value-free (contract.test.ts).
export type {
  TranscriptItem,
  MessageStreamProps,
  DmMessageProps,
  DmCorrectionProps,
  PlayerMessageProps,
  SessionInputProps,
  ThinkingIndicatorProps,
  SessionStartBeatProps,
  SessionPreparingProps,
  CardItem,
  RollPhase,
  RollRevealView,
  RollCardProps,
  RollCardLabels,
  DieSpinProps,
} from './session/index.ts'
// Invite/join contracts (MYT-91) — the DOM-free prop vocabulary for the two
// invite/join @mythrun/ui components (InvitePanel, JoinPreview) plus the arm
// unions the accept/preview error mappings resolve to. Type-only (the barrel
// stays keyless — contract.test.ts).
export type {
  AcceptArmKind,
  PreviewArmKind,
  InvitePanelLabels,
  InvitePanelProps,
  JoinPreviewLabels,
  JoinPreviewProps,
} from './invite/types.ts'
// Billing contracts (MYT-95) — the DOM-free prop vocabulary for the billing
// @mythrun/ui components on the Sessions & Billing settings surface. Type-only
// (§9): pure data + shell-owned i18n'd labels, no React/DOM types.
export type { CreditBalanceProps } from './billing/index.ts'
export type { PackListProps, SubscriptionTierView, AlaCarteView } from './billing/index.ts'
export type { PurchasePromptProps } from './billing/index.ts'
export type { PurchaseHistoryProps, PurchaseHistoryRow } from './billing/index.ts'

// Knowledge-layer contracts (MYT-94) — the DOM-free prop + shared-type vocabulary for
// the entity-highlighting + knowledge-sidebar @mythrun/ui components (EntityMention /
// EntityPopover / SessionSheet / KnowledgeSidebar). Re-exports the matcher vocabulary
// (Task 3) + the three brain view-models (cache / sheet-state / character overlay) so a
// consumer reads them off this surface. Type-only (§9): pure data + neutral callbacks +
// resolved i18n-key labels, no className/style/raw DOM events.
export type {
  EntityGlyph,
  EntityCard,
  ProseSegment,
  EntityIndex,
  KnowledgeCache,
  SessionSheetState,
  CharacterOverlay,
  KnowledgeTab,
  WikiTabLabels,
  SessionSheetLabels,
  EntityMentionProps,
  EntityPopoverProps,
  SessionSheetPanelProps,
  KnowledgeSidebarProps,
} from './session-knowledge.ts'
