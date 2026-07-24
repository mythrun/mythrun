import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { HttpError } from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { RouteErrorBoundary } from './error-boundary.tsx'
import { clearRetryAttempts, recordRetryAttempt } from '../platform/web/retry-tracker.ts'

// The route error boundary's retryable arm (myth-t1ccl). A persistent failure used to
// loop "try again" forever with no counter, escalation, or diagnostics. These specimens
// render the REAL boundary catching a thrown route error, at two burst counts:
//   • FirstFailure — the plain retry (a first, hopefully-transient blip).
//   • Escalated    — after retries have re-failed: escalated copy, a harder-reset
//     button, and a terse support reference (the underlying error is also logged to
//     the console every time it shows).
// The burst count is seeded through the platform tracker (not sessionStorage directly)
// so the specimen is deterministic regardless of which story rendered before it.

// A representative server error code for the escalated specimen's support reference
// (not user-facing copy — a wire code the console/support would echo).
const SPECIMEN_ERROR_CODE = 'service_unavailable'

function ErrorBoundaryHarness({
  attempts,
  code,
}: {
  readonly attempts: number
  readonly code?: string
}): React.JSX.Element {
  // Seed the retry burst ONCE per mount, before the boundary reads it on first paint.
  useState(() => {
    clearRetryAttempts()
    for (let i = 0; i < attempts; i += 1) recordRetryAttempt()
    return null
  })
  function Throw(): React.JSX.Element {
    throw new HttpError(503, 'HTTP 503', code)
  }
  const router = createMemoryRouter(
    [{ path: '/', element: <Throw />, errorElement: <RouteErrorBoundary /> }],
    { initialEntries: ['/'] },
  )
  return (
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>
  )
}

const meta: Meta<typeof ErrorBoundaryHarness> = {
  title: 'Screens/ErrorBoundary',
  component: ErrorBoundaryHarness,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof ErrorBoundaryHarness>

export const FirstFailure: Story = {
  name: 'Error · first failure (plain retry)',
  render: () => <ErrorBoundaryHarness attempts={0} />,
}

export const Escalated: Story = {
  name: 'Error · persistent failure (escalated + reference)',
  render: () => <ErrorBoundaryHarness attempts={3} code={SPECIMEN_ERROR_CODE} />,
}
