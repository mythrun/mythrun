// Authoring context for every key in the i18n catalog (locales/en/common.json).
//
// This is NOT loaded at runtime — i18next serves only the catalog. It is the
// reference an author/translator reads when replacing a `[ph_*]` placeholder
// with real copy: what the key stands for, and the rough shape/length of the
// real string (the catalog placeholder is deliberately length-matched to it).
//
// One shared context map, keyed by the catalog's dotted key-path, serves every
// locale (descriptions describe meaning, not a specific translation). The drift
// test in resources.test.ts asserts this map and the catalog have exactly the
// same key set — every key documented, no orphans.
export const descriptions: Record<string, string> = {
  back: 'Back-navigation affordance label. A real shipped string (generic chrome), not a placeholder.',
  appGreeting: 'Greeting for a signed-in player; interpolates {{name}}. Short — a couple of words, e.g. "Welcome back,".',
  richSample: 'Dev-only specimen exercising rich-text (Trans) rendering with an embedded <1>link</1>. Not shipped UI.',
  'frame.logo': 'The Mythrun wordmark in the app-frame header. Short brand text (~1 word).',
  'frame.displayName': "The signed-in player's display name in the header. A name (~10-15 chars); truncates when long.",
  'frame.credits': 'The player\'s credit balance in the header. A short number like "120" or "1,250".',
  'frame.settings': 'Accessible name for the gear settings IconButton in the header (aria-label, not visible text). A short verb/noun, e.g. "Settings".',
  'splash.loading': 'Accessible loading label on the boot splash shown while the on-load session refresh settles. Short (~2-4 words).',
  'callback.loading': 'Loading label on the OAuth callback screen while the code is exchanged. Short.',
  'callback.error': "Error message on the OAuth callback screen when the exchange fails or state doesn't match. ~1 sentence with a retry nudge.",
  'notFound.title': 'Headline on the 404 screen. Short (~2-4 words).',
  'notFound.body': 'Explanation on the 404 screen. ~1 sentence: what happened, plus a nudge back home.',
  'error.title': 'Headline on the generic error screen. Short (~2-4 words).',
  'error.body': 'Explanation on the generic error screen. ~1 sentence on what went wrong.',
  'error.retry': 'Retry affordance label on the error screen. ~1 word, e.g. "Retry".',
  'error.contractTitle': 'Dev-only headline shown when the frontend/backend contract drifts. Short.',
  'error.contractBody': 'Dev-only explanation of a contract drift. ~1 sentence, with a remediation hint.',
  'home.title': 'Heading on the home hub. Short (~2-3 words), e.g. "Your campaigns".',
  'home.loading': 'Loading label on the home hub while campaigns are fetched. Short.',
  'home.empty': 'Empty-state message on the home hub when the player has no campaigns. ~1 short sentence + a nudge to start.',
  'home.status.setup': 'Campaign status pill: world generation / setup in progress. ~1 word.',
  'home.status.active': 'Campaign status pill: ready / in play. ~1 word.',
  'home.status.archived': 'Campaign status pill: archived. ~1 word.',
  'home.status.failed': 'Campaign status pill: setup failed. ~1 word.',
  'theme.toggle': 'Accessible name (aria-label) for the theme-toggle FAB. A real shipped string (generic chrome), ~1 word.',
  'signin.wordmark': 'The Mythrun wordmark on the sign-in title screen. The brand name (~1 word).',
  'signin.tagline': 'The terse at-the-table tagline under the wordmark on sign-in. ~1 sentence, evocative, no hype.',
  'signin.google': 'Label for the "continue with Google" provider button. Functional (real string).',
  'signin.discord': 'Label for the "continue with Discord" provider button. Functional (real string).',
  'signin.legal': 'The small Terms · Privacy line at the foot of the sign-in screen. Short.',
  'signin.suspended': 'Notice shown on sign-in when the account was suspended. ~1 sentence with a contact nudge.',
  'onboard.prompt': 'The serif "what should we call you?" question on onboarding — the question that IS the label. ~1 short sentence.',
  'onboard.nameLabel': 'Accessible name (aria-label) for the display-name input on onboarding. Functional, ~2 words.',
  'onboard.continue': 'Label for the single primary action on onboarding. Functional, ~1 word.',
  'onboard.hint': 'Reassuring sub-line under the onboarding action ("you can change this later"). Short.',
  'onboard.errors.displayNameInvalid': 'Inline error under the onboarding input when the display name is rejected. ~1 sentence.',
  'onboard.errors.generic': 'Generic onboarding failure notice (rate-limited / exhausted retries). ~1 sentence with a retry nudge.',
  'stub.landing': 'Placeholder label for the not-yet-built landing screen (a flow ticket owns the real screen). ~screen-title length.',
  'stub.join': 'Placeholder label for the not-yet-built invite-join screen (a flow ticket owns the real screen).',
  'stub.recap': 'Placeholder label for the not-yet-built session-recap screen (a flow ticket owns the real screen).',
  'stub.campaignNew': 'Placeholder label for the not-yet-built campaign-create screen (a flow ticket owns the real screen).',
  'stub.characterNew': 'Placeholder label for the not-yet-built character-create screen (a flow ticket owns the real screen).',
  'stub.play': 'Placeholder label for the not-yet-built play screen (a flow ticket owns the real screen).',
  'stub.settings': 'Placeholder label for the not-yet-built settings screen (a flow ticket owns the real screen).',
}
