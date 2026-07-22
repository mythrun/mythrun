import assert from 'node:assert'
import { ESLint } from 'eslint'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import i18next from 'eslint-plugin-i18next'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments'
import { noUntranslatedJsxText } from './no-untranslated-jsx-text.js'

const here = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(here, '..')
const uiDir = resolve(frontendDir, 'ui')
const clientCoreDir = resolve(frontendDir, 'client-core')

describe('frontend lint rails — registration & scoping', () => {
  it('rails are error for feature code; no-ad-hoc-ui off in the library', async () => {
    const web = new ESLint({ cwd: frontendDir })
    const cfg = await web.calculateConfigForFile(resolve(frontendDir, 'src/app.tsx'))
    expect(cfg.rules['mythrun-ui/no-ad-hoc-ui']?.[0]).toBe(2)
    expect(cfg.rules['i18next/no-literal-string']?.[0]).toBe(2)
    // The app config must run i18next in 'jsx-only' (not the default
    // 'jsx-text-only'): jsx-only additionally covers JSX *attribute* literals
    // (<Widget label="…" />), which the weaker default lets through. Asserting
    // the mode here pins the load-bearing choice, not just that the rail is on.
    expect(cfg.rules['i18next/no-literal-string']?.[1]?.mode).toBe('jsx-only')
    expect(cfg.rules['@eslint-community/eslint-comments/require-description']?.[0]).toBe(2)
    // calculateConfigForFile normalizes reportUnusedDisableDirectives from the
    // configured 'error' string to the numeric severity 2 (same normalization
    // ESLint applies to rule severities). 2 === error, so this still proves the
    // directive-checking is on at error level.
    expect(cfg.linterOptions?.reportUnusedDisableDirectives).toBe(2)

    const ui = new ESLint({ cwd: uiDir })
    const libCfg = await ui.calculateConfigForFile(
      resolve(uiDir, 'src/components/Text/Text.tsx'),
    )
    expect(libCfg.rules['mythrun-ui/no-ad-hoc-ui']?.[0] ?? 0).toBe(0)
  })

  it('no-untranslated-jsx-text is error; i18next rail uses real jsx-attributes.exclude', async () => {
    const web = new ESLint({ cwd: frontendDir })
    const cfg = await web.calculateConfigForFile(resolve(frontendDir, 'src/app.tsx'))
    expect(cfg.rules['mythrun-ui/no-untranslated-jsx-text']?.[0]).toBe(2)
    const i18nextOpts = cfg.rules['i18next/no-literal-string']?.[1]
    expect(i18nextOpts?.['jsx-attributes']?.exclude).toContain('data-testid')
  })
})

describe('frontend lint rails — fire on violation (isolated, no type-aware build)', () => {
  it('i18next/no-literal-string (jsx-only) reports a JSX attribute string literal', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        // `files` matcher is required: with overrideConfigFile + a .jsx
        // fixture, ESLint flat config emits "File ignored because no matching
        // configuration was supplied" (the default applies-to glob is
        // **/*.js, not .jsx) and the rule never runs.
        files: ['**/*.jsx'],
        plugins: { i18next },
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'i18next/no-literal-string': ['error', { mode: 'jsx-only' }] },
      },
    })
    // A JSX *attribute* literal (<Widget label="Hello world" />) fires ONLY
    // under mode 'jsx-only'; the weaker 'jsx-text-only' default lets attribute
    // strings through (it reports bare JSX text children only). Using an
    // attribute fixture therefore proves jsx-only's attribute coverage — the
    // exact reason we chose it over jsx-text-only — rather than something both
    // modes would catch. (`label` is not in i18next's default ignoreAttribute
    // exclusion list, so it is checked.)
    const [res] = await eslint.lintText(
      'export function Comp() {\n  return <Widget label="Hello world" />\n}\n',
      {
        filePath: 'fixture.jsx',
      },
    )
    // noUncheckedIndexedAccess types the destructure as LintResult | undefined;
    // assert it exists (a result row is always present) so the access narrows.
    assert(res)
    expect(res.messages.map((m) => m.ruleId)).toContain('i18next/no-literal-string')
  })

  it('eslint-comments/require-description reports a reason-less disable directive', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        plugins: { '@eslint-community/eslint-comments': eslintComments },
        rules: { '@eslint-community/eslint-comments/require-description': 'error' },
      },
    })
    const [res] = await eslint.lintText('// eslint-disable-line no-console\nconsole.log(1)\n', {
      filePath: 'fixture.js',
    })
    assert(res)
    expect(res.messages.map((m) => m.ruleId)).toContain(
      '@eslint-community/eslint-comments/require-description',
    )
  })

  it('i18next rail exempts data-testid via jsx-attributes.exclude', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.jsx'],
        plugins: { i18next },
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          'i18next/no-literal-string': [
            'error',
            {
              mode: 'jsx-only',
              'jsx-attributes': {
                exclude: [
                  'className',
                  'styleName',
                  'style',
                  'type',
                  'key',
                  'id',
                  'width',
                  'height',
                  'data-testid',
                  'aria-.*',
                  'role',
                ],
              },
            },
          ],
        },
      },
    })
    const [res] = await eslint.lintText(
      'export const A = () => <Widget data-testid="x" />\n',
      { filePath: 'fixture.jsx' },
    )
    assert(res)
    expect(res.messages.map((m) => m.ruleId)).not.toContain('i18next/no-literal-string')
  })
})

describe('no-untranslated-jsx-text — fire on violation', () => {
  function isolated(): ESLint {
    return new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.jsx'],
        plugins: { 'mythrun-ui': { rules: { 'no-untranslated-jsx-text': noUntranslatedJsxText } } },
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'mythrun-ui/no-untranslated-jsx-text': 'error' },
      },
    })
  }
  async function ids(code: string): Promise<(string | null)[]> {
    const [res] = await isolated().lintText(code, { filePath: 'fixture.jsx' })
    if (!res) throw new Error('no lint result')
    return res.messages.map((m) => m.ruleId)
  }
  it('fires on bare text + template-literal children; silent on t()/<Trans>', async () => {
    expect(await ids('export const A = () => <Text>hi</Text>\n')).toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
    expect(await ids('export const A = () => <Text>{`hi`}</Text>\n')).toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
    expect(await ids('export const A = () => <Text>{t("k")}</Text>\n')).not.toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
    expect(await ids('export const A = () => <Trans>hi</Trans>\n')).not.toContain(
      'mythrun-ui/no-untranslated-jsx-text',
    )
  })
})

describe('MYT-100 — @mythrun/ui text rail registration & scoping', () => {
  it('no-untranslated-jsx-text is error on library component source', async () => {
    const ui = new ESLint({ cwd: uiDir })
    const cfg = await ui.calculateConfigForFile(resolve(uiDir, 'src/components/Text/Text.tsx'))
    // The MYT-100 root cause: this rail was absent from the library config, so the
    // app-layer text-rail floor did not reach DS-owned surfaces. It is now error here.
    expect(cfg.rules['mythrun-ui/no-untranslated-jsx-text']?.[0]).toBe(2)
  })

  it('the text rail does NOT lint stories or tests (they render literal fixture text)', async () => {
    const ui = new ESLint({ cwd: uiDir })
    const story = await ui.calculateConfigForFile(
      resolve(uiDir, 'src/components/FullBleedStage/FullBleedStage.stories.tsx'),
    )
    // 0 (or absent → coalesced to 0). Stories legitimately hold literal text.
    expect(story.rules['mythrun-ui/no-untranslated-jsx-text']?.[0] ?? 0).toBe(0)
    // no-ad-hoc-color stays ON for the same story file — the shared-plugin wiring
    // must not have dropped the color rail while adding the text rail.
    expect(story.rules['mythrun-ui/no-ad-hoc-color']?.[0]).toBe(2)

    const test = await ui.calculateConfigForFile(
      resolve(uiDir, 'src/theme/theme-provider.test.tsx'),
    )
    expect(test.rules['mythrun-ui/no-untranslated-jsx-text']?.[0] ?? 0).toBe(0)
  })
})

describe('MYT-100 — placeholder ([ph) ban registration & fire', () => {
  // The ban re-lists the repo-wide default-export selector (flat config REPLACES
  // no-restricted-syntax, it does not merge), then adds the two `[ph` selectors.
  // Asserting both here pins that the override did not drop the inherited rail.
  async function selectorsFor(dir: string, file: string): Promise<string[]> {
    const eslint = new ESLint({ cwd: dir })
    const cfg = await eslint.calculateConfigForFile(resolve(dir, file))
    const entry = cfg.rules['no-restricted-syntax'] as
      | [number, ...{ selector: string }[]]
      | undefined
    if (!entry) throw new Error('no-restricted-syntax not configured')
    return entry.slice(1).map((o) => (o as { selector: string }).selector)
  }

  it('every package src keeps the default-export ban AND gains the [ph selectors', async () => {
    for (const [dir, file] of [
      [frontendDir, 'src/app.tsx'],
      [uiDir, 'src/components/Text/Text.tsx'],
      [clientCoreDir, 'src/index.ts'],
    ] as const) {
      const selectors = await selectorsFor(dir, file)
      expect(selectors).toContain('ExportDefaultDeclaration') // inherited rail preserved
      expect(selectors.some((s) => s.startsWith('Literal'))).toBe(true) // string-literal matcher
      expect(selectors.some((s) => s.startsWith('TemplateElement'))).toBe(true) // template matcher
      expect(selectors.some((s) => s.startsWith('JSXText'))).toBe(true) // bare-JSX-text matcher
    }
  })

  // Isolated fire proof: the `[ph` selectors embed `[`/`]` INSIDE the esquery regex
  // (`/\[ph[:_]/`), which the DROP-SCHEMA precedent does not exercise. Prove the
  // selectors parse and fire (and respect the `[ph` + `:`/`_` boundary) directly.
  function phIsolated(): ESLint {
    return new ESLint({
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: {
          'no-restricted-syntax': [
            'error',
            { selector: 'Literal[value=/\\[ph[:_]/]', message: 'ph literal' },
            { selector: 'TemplateElement[value.raw=/\\[ph[:_]/]', message: 'ph template' },
            { selector: 'JSXText[value=/\\[ph[:_]/]', message: 'ph jsx text' },
          ],
        },
      },
    })
  }
  async function phIds(code: string, filePath = 'fixture.ts'): Promise<(string | null)[]> {
    const [res] = await phIsolated().lintText(code, { filePath })
    if (!res) throw new Error('no lint result')
    return res.messages.map((m) => m.ruleId)
  }

  it('fires on `[ph:` / `[ph_` string literals, `[ph:` templates, and bare JSX text', async () => {
    expect(await phIds("export const x = '[ph: places]'\n")).toContain('no-restricted-syntax')
    expect(await phIds("export const x = '[ph_hint]'\n")).toContain('no-restricted-syntax')
    expect(await phIds('export const x = `[ph: ${y}]`\n')).toContain('no-restricted-syntax')
    // Bare JSX text — the story/test shape the two literal matchers miss.
    expect(
      await phIds('export const A = () => <span>[ph: wordmark]</span>\n', 'fixture.tsx'),
    ).toContain('no-restricted-syntax')
  })

  it('does NOT fire on real copy or on `[ph`-adjacent non-placeholder strings', async () => {
    // The `[:_]` boundary means `[ph` must be immediately followed by `:` or `_`.
    // A CSS-ish `[placeholder]` and a word like `[phase]` must stay clean.
    expect(await phIds("export const x = 'Begin again'\n")).not.toContain('no-restricted-syntax')
    expect(await phIds("export const x = '[placeholder]'\n")).not.toContain('no-restricted-syntax')
    expect(await phIds("export const x = '[phase two]'\n")).not.toContain('no-restricted-syntax')
  })
})
