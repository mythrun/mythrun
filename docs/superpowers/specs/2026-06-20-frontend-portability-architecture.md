# Frontend Portability Architecture — Decision Record

> **Type**: Architecture decision record (NOT a per-issue feature spec)
> **Date**: 2026-06-20 · **Status**: Decided
> **Scope**: the whole Frontend milestone + the future native (iOS/Android) apps
> **Decided with** Miklos during the MYT-80/81 wrap-up. Research: two current-state (2026-06) web→native landscape passes.

---

## 1. Decision

Mythrun ships **web (desktop + mobile-web) at launch** and ports to **true-native iOS + Android (phone + tablet) post-launch**. We adopt a **shared client-core + platform-specific UI** architecture (the "web-first inversion"). We explicitly reject:
- **Universal React / React-Native-Web "build once"** — its value is *identical UI everywhere paid for by a degraded web* (RNW is in maintenance mode; weak SEO/CSS; `<div>`+ARIA a11y). We want a high bar on BOTH platforms and we *want* the native app to diverge — RNW fights both.
- **Capacitor / webview wrap** — hard quality ceiling on native; fails our native bar.

**Goals that drove this:** high quality on web *and* native; the native app is intentionally **not a 1:1 copy**; the port must be **grindy-but-direct** (mechanical translation against a fixed spec — which the agent automates), never a redesign or a framework fight. Deferring the native UI engine also lets us land it on a settled ecosystem (today: NativeWind-stable is Tailwind v3 while we're on v4; the native 3D-renderer story is between a deprecated OpenGL bridge and a young WebGPU lib — all reasons not to commit now).

## 2. Target architecture

Five workspace packages — three exist/are-planned now, two are the future native side. **`backend/` is unrelated to all of this** (it's the cloud server; see §6).

```
@mythrun/client-core   ← the platform-agnostic CLIENT brain. Runs on the user's device
                          (web + phone). ZERO DOM, zero UI framework.
   · domain types + client view-state (stores/machines)
   · API client + WS session client + streaming-client LOGIC (over injected transport)
   · i18n catalog (keys + en resources) + typed-keys setup
   · design-token source (the generator/manifest; web CSS + native config both emit FROM it)
   · combat scene-graph (react-three-fiber description) behind a Renderer interface
   · platform-capability INTERFACES: Storage, SecureStorage, Locale, Share, Push,
     DeepLink, StreamingFetch(SSE), Clipboard — defined here, implemented per platform
   · the component CONTRACT (prop types/variants; imports `react`, never react-dom/native)

@mythrun/ui            ← WEB design system: DOM + Tailwind, implements the contract
@mythrun/web           ← WEB app: Vite + React Router; screens compose client-core + ui

              ── future native side ──
@mythrun/ui-native     ← NATIVE design system: RN + NativeWind, implements the SAME contract
@mythrun/native        ← Expo app: Expo Router; screens RE-COMPOSED for native, on core + ui-native
```

**Load-bearing idea:** `@mythrun/client-core` is imported *verbatim* by both apps. It can't see the DOM or any UI framework, so it's trivially reusable. Every platform-divergent capability is reached only through an interface the core *defines* and each app *fills in* — so the native glue surface is finite and enumerable in advance.

## 3. The port (post-launch, in order)

1. **Scaffold `@mythrun/native`** — Expo (latest SDK) + Expo Router + NativeWind + New Architecture; wire into the workspace + mirror the gate pattern.
2. **Implement the platform interfaces for native** — Storage→MMKV/AsyncStorage, SecureStorage→expo-secure-store, Locale→expo-localization (+ Hermes Intl polyfills), StreamingFetch→`expo/fetch`, Share/Push/DeepLink→Expo modules. This is the *entire* native-glue surface, known up front because the core declared every interface. `@mythrun/client-core` then imports unchanged.
3. **Generate the native token config** from the same canonical generator → NativeWind theme. Values match by construction (tokens are hex — portable).
4. **Build `@mythrun/ui-native`** — re-implement each component in RN primitives + NativeWind, *typed against the shared contract* (tsc guarantees prop-API parity). The grind: ~N components, each a direct DOM→RN translation against a fixed spec.
5. **Re-compose the screens in `@mythrun/native`** — deliberately diverge (native nav/gestures, phone↔tablet adaptive). Screens are thin compositions of core + ui-native + keys, so this is assembly + native-UX design, not logic archaeology.
6. **Native combat renderer** — implement the `Renderer` interface with the mature-at-port-time backend (react-native-webgpu + Three's WebGPURenderer, or a `'use dom'` WebView bridge). The r3f scene-graph carries; backend + controls + asset loading are native impls.
7. **The two known-hard widgets** — inline rich-text entity chips + word-anchored popovers get bespoke native impls behind their existing feature interfaces.
8. **Verify + ship** — RN Testing Library, native gates, EAS build/submit.

**Why grindy-not-painful:** every native artifact has a *fixed target* before a line is written — the contract (props), the tokens (values), the keys (strings), the core (behavior). The native impl is a translation against a spec; that's what's cheap to automate. The only genuine *design* work is intentional (native nav + the two hard widgets).

## 4. Carries / rebuilt / new (grounded in research)

- **Verbatim:** client-core (domain, view-state, API+WS clients, i18n catalog + typed keys, token source, r3f scene-graph), the `no-untranslated-jsx-text` lint, the WebSocket layer (improves — RN allows custom handshake headers).
- **Re-implemented against a fixed spec (the grind):** every UI component (DOM→RN), screens (re-composed/diverged), the token *config* (CSS→NativeWind), fonts (@fontsource→expo-font), SSE (→`expo/fetch` — the "EventSource can't set headers" pain disappears).
- **Genuinely new native work:** the combat renderer backend, inline entity chips, word-anchored popovers, the platform-capability impls.

## 5. Conformance rules — the enforced "portability rules of the road"

Each derives from a port step, is backed by a check, and switches on when its surface first exists (rails-before-track).

| # | Rule | Derives from | Enforcement | Lands at |
|---|---|---|---|---|
| **R1** | `@mythrun/client-core` is a real package and is **DOM-free**; all platform-divergent capability is reached only through core interfaces — *even the web app uses them*. | step 2 (core imported verbatim; impl the interfaces) | (a) **package boundary** — no react-dom / `@mythrun/ui` / web-only deps in client-core; (b) ESLint `no-restricted-globals` banning the *divergent* globals (`document, window, localStorage, sessionStorage, location, navigator, EventSource`) in client-core **and** in app code outside the designated `platform/web/**` impl modules. Universal globals (`fetch`, `WebSocket`) stay allowed. | **MYT-83** (build the data/state/transport layer *into* client-core from day one — never in `web/src` — so there's no later extraction) |
| **R2** | One shared, platform-neutral **component contract**; every implementation is typed against it. | step 4 (ui-native satisfies the SAME contract) | (a) contract prop-types in client-core, importing only `react`; (b) **tsc** — each impl typed `(props: ButtonProps)` → compiler guarantees parity (free, exact); (c) existing `no-ad-hoc-ui` (consumers compose the API only); (d) **API-purity lint** — mythrunUI components may not expose DOM-only props (`className`/`style` passthrough, `React.CSSProperties`, DOM mouse handlers). | **MYT-82** (component library) |
| **R3** | Tokens have **one canonical, platform-neutral source in the shared layer**; web CSS + native config both generate from it; components reference tokens, never ad-hoc values. | step 3 (native config from the same token source) | (a) the `generatePalette()` generator (already canonical + emits a neutral manifest) **moves into the shared layer** (currently in web `@mythrun/ui`) so both ui packages generate from it; (b) existing idempotent-generator check; (c) **no-ad-hoc-color lint** — ban raw hex/`rgb()` + arbitrary-value color utilities in components. | **MYT-82** (no-ad-hoc-color lint) + the restructure (move the generator into client-core) |
| **R4** | The 3D renderer is reached only through the `Renderer` interface. | step 6 (swap the native backend) | ESLint `no-restricted-imports` banning `three` / `@react-three/*` outside the one renderer module (mirrors the backend's `ai`-import ban). | **Combat L2** (the frontend combat view) |
| **R5** | **Screens are thin** — no business logic, no platform access, no ad-hoc UI; they compose core + components + keys. | step 5 (screens re-composed, not untangled) | Emergent from R1 (no platform access) + `no-ad-hoc-ui` (no raw UI) + i18n (no raw strings); optionally a boundary rule that feature dirs import only from client-core + ui + i18n. | **MYT-83** (app-shell structure) |

**The two that carry the strategy:** R1 (DOM-free, interface-gated core → verbatim-reusable + enumerable native glue) and R2 (shared contract enforced by tsc → every component port is a typed mechanical translation). R3–R5 support.

**The one structural "do it now":** when MYT-83 introduces the data/state/transport layer, build it **into `@mythrun/client-core` from day one**, not `@mythrun/web/src`. Costs nothing extra now; avoids a later extraction refactor.

## 6. Naming — backend vs client-core

- **`backend/`** = the **server** (cloud, ECS). Owns the DB/Redis/workers + all AI cognition (Fast/Slow Thinker, Scribe, enforced ignorance, dice, ledger). One instance; the source of truth; serves an API.
- **`@mythrun/client-core`** = the **client brain** that runs on every user's device — the half of the app that isn't pixels and isn't the server: the API/WS *client*, this user's view-state, the strings, the tokens, display logic. It never touches the DB or LLM; it only speaks to the backend over the wire.
- **`@mythrun/ui` (web) / `@mythrun/ui-native` (future)** = the **faces** (pixels per platform).

The API *server* (backend) and the API *client* (client-core) are two halves of one phone call. The new split this record introduces is *within the client*: brain (`client-core`, shared web+native) vs. face (`ui`, per platform). The native apps are a **post-launch milestone**; nothing here changes the launch (web) plan or reworks MYT-79–81.
