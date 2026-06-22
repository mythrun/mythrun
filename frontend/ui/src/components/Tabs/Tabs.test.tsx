import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { Tabs } from './Tabs.tsx'

const ITEMS = [
  { value: 'overview', label: 'tab.overview', content: <div>overview-panel</div> },
  { value: 'lore', label: 'tab.lore', content: <div>lore-panel</div> },
  { value: 'map', label: 'tab.map', content: <div>map-panel</div> },
] as const

describe('Tabs', () => {
  it('renders a labelled tablist with the first tab active by default', () => {
    render(<Tabs items={ITEMS} label="tabs.world" />)
    const list = screen.getByRole('tablist')
    expect(list).toHaveAccessibleName('tabs.world')
    expect(screen.getByRole('tab', { name: 'tab.overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('overview-panel')).toBeInTheDocument()
  })

  it('associates the active panel with its tab (aria-controls / aria-labelledby)', () => {
    render(<Tabs items={ITEMS} label="tabs.world" />)
    const tab = screen.getByRole('tab', { name: 'tab.overview' })
    const panel = screen.getByRole('tabpanel')
    // Radix wires the relationship both ways.
    expect(tab).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toHaveAttribute('aria-labelledby', tab.id)
  })

  // KEYBOARD: arrow keys move between tabs (roving tabindex). Radix activates on
  // focus by default, so ArrowRight selects the next tab + shows its panel.
  it('keyboard: ArrowRight/ArrowLeft move between tabs and switch panels', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Tabs items={ITEMS} label="tabs.world" onChange={onChange} />)

    screen.getByRole('tab', { name: 'tab.overview' }).focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'tab.lore' })).toHaveAttribute('aria-selected', 'true')
    })
    expect(screen.getByText('lore-panel')).toBeInTheDocument()
    expect(onChange).toHaveBeenCalledWith('lore')
    expect(typeof onChange.mock.calls[0]?.[0]).toBe('string')

    await user.keyboard('{ArrowLeft}')
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'tab.overview' })).toHaveAttribute('aria-selected', 'true')
    })
  })

  it('pointer: clicking a tab activates it and shows its panel', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Tabs items={ITEMS} label="tabs.world" onChange={onChange} />)
    await user.click(screen.getByRole('tab', { name: 'tab.map' }))
    await waitFor(() => {
      expect(screen.getByText('map-panel')).toBeInTheDocument()
    })
    expect(onChange).toHaveBeenCalledWith('map')
  })

  it('a disabled tab is present but not selectable', async () => {
    const items = [
      { value: 'a', label: 'tab.a', content: <div>a-panel</div> },
      { value: 'b', label: 'tab.b', content: <div>b-panel</div>, disabled: true },
    ]
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Tabs items={items} label="tabs.x" onChange={onChange} />)
    const disabledTab = screen.getByRole('tab', { name: 'tab.b' })
    expect(disabledTab).toBeDisabled()
    await user.click(disabledTab)
    expect(screen.queryByText('b-panel')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('controlled: value drives the active tab', async () => {
    const user = userEvent.setup()
    function Controlled() {
      const [v, setV] = useState('overview')
      return <Tabs items={ITEMS} label="tabs.world" value={v} onChange={setV} />
    }
    render(<Controlled />)
    expect(screen.getByText('overview-panel')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'tab.lore' }))
    await waitFor(() => {
      expect(screen.getByText('lore-panel')).toBeInTheDocument()
    })
  })

  it('the active tab carries the flat --border-strong indicator (token, not shadow)', () => {
    render(<Tabs items={ITEMS} label="tabs.world" />)
    const active = screen.getByRole('tab', { name: 'tab.overview' })
    expect(active.className).toContain('data-[state=active]:border-border-strong')
  })

  it('has no axe violations', async () => {
    const { container } = render(<Tabs items={ITEMS} label="tabs.world" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
