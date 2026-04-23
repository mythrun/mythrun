import { describe, it, expect } from 'vitest'
import { extractRunbookEntries } from '../extractRunbooks.ts'
import type { TocEntry } from '../extractToc.ts'

describe('extractRunbookEntries', () => {
  it('returns empty for a toc with no "Operating this piece" section', () => {
    const toc: TocEntry[] = [
      { level: 2, id: 'how-it-fits', text: 'How it fits together' },
      { level: 3, id: 'subnets', text: 'Subnets' },
      { level: 2, id: 'source', text: 'Source' },
    ]
    expect(extractRunbookEntries(toc)).toEqual([])
  })

  it('collects only h3 entries under "Operating this piece"', () => {
    const toc: TocEntry[] = [
      { level: 2, id: 'how-it-fits', text: 'How it fits together' },
      { level: 3, id: 'subnets', text: 'Subnets' },
      { level: 2, id: 'operating-this-piece', text: 'Operating this piece' },
      { level: 3, id: 'expand-cidr', text: 'Expand the CIDR range' },
      { level: 3, id: 'rotate-nat', text: 'Rotate the NAT instance' },
      { level: 2, id: 'source', text: 'Source' },
      { level: 3, id: 'terraform', text: 'Terraform path' },
    ]
    expect(extractRunbookEntries(toc)).toEqual([
      { title: 'Expand the CIDR range', id: 'expand-cidr' },
      { title: 'Rotate the NAT instance', id: 'rotate-nat' },
    ])
  })

  it('stops collecting at the next h2 (not at a h3)', () => {
    const toc: TocEntry[] = [
      { level: 2, id: 'operating-this-piece', text: 'Operating this piece' },
      { level: 3, id: 'one', text: 'One' },
      { level: 2, id: 'appendix', text: 'Appendix: inputs & outputs' },
      { level: 3, id: 'vars', text: 'Variables' },
    ]
    expect(extractRunbookEntries(toc)).toEqual([{ title: 'One', id: 'one' }])
  })

  it('preserves order of h3 entries within the section', () => {
    const toc: TocEntry[] = [
      { level: 2, id: 'operating-this-piece', text: 'Operating this piece' },
      { level: 3, id: 'charlie', text: 'Charlie' },
      { level: 3, id: 'alpha', text: 'Alpha' },
      { level: 3, id: 'bravo', text: 'Bravo' },
    ]
    expect(extractRunbookEntries(toc)).toEqual([
      { title: 'Charlie', id: 'charlie' },
      { title: 'Alpha', id: 'alpha' },
      { title: 'Bravo', id: 'bravo' },
    ])
  })

  it('is case-sensitive on the h2 text (exact match only)', () => {
    const toc: TocEntry[] = [
      { level: 2, id: 'operating-this', text: 'operating this piece' },
      { level: 3, id: 'x', text: 'X' },
    ]
    expect(extractRunbookEntries(toc)).toEqual([])
  })
})
