import { useState } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// A minimal per-story TanStack provider for ROUTE stories that pin a component
// directly (injected fakes) rather than mounting the full app via ScreenHarness.
// Lives under src/storybook/ because `src/routes/**` structurally bans the
// react-query import (R5/conformance — screens consume client-core hooks); a
// story DECORATOR is harness wiring, same as ScreenHarness, so the provider is
// authored here and imported by the story. First use: the SessionShell stories —
// the shell's mount-time balance invalidation (myth-q53lj) reads the query client.

/** Wrap a story in a fresh, retry-free QueryClient (one per story mount). */
export function StoryQueryProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
