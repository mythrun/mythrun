import type { ReactNode } from 'react'

export interface TextProps {
  readonly children: ReactNode
}

// The library zone is where raw elements legitimately live (no-ad-hoc-ui is
// OFF for frontend/ui/**). Real typography variants land in MYT-82.
export function Text({ children }: TextProps): React.JSX.Element {
  return <span>{children}</span>
}
