export interface Page {
  slug: string
  title: string
}

export interface Section {
  slug: string
  title: string
  pages: [Page, ...Page[]]
}

export interface PageMeta {
  sourcePaths: string[]
  sourceHash: string | null
  lastTicket: string | null
}
