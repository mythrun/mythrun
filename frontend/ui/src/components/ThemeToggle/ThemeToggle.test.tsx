import { describe, expect, it, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { axe } from 'jest-axe'
import { ThemeProvider } from '../../theme/theme-provider.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'

function setMatch(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches,
      media: q,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

describe('ThemeToggle', () => {
  it('renders an accessible-named button and flips the theme on click', () => {
    setMatch(false)
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    render(
      <ThemeProvider>
        <ThemeToggle label="Theme" />
      </ThemeProvider>,
    )
    const btn = screen.getByRole('button', { name: 'Theme' })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    // Wrap the click in act() so the provider's passive useEffect (which applies
    // `.dark` to <html>) flushes before we assert — the same idiom the sibling
    // theme-provider test uses for the same flip. A bare synchronous .click()
    // returns before passive effects run, so the class isn't on yet.
    act(() => {
      btn.click()
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('has no axe violations', async () => {
    setMatch(false)
    const { container } = render(
      <ThemeProvider>
        <ThemeToggle label="Theme" />
      </ThemeProvider>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
