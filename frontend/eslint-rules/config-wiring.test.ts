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
