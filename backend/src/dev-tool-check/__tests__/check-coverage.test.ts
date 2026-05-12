import { describe, expect, it } from 'vitest'
import { checkCoverage } from '../check-coverage.js'

describe('checkCoverage', () => {
  it('passes when contracts are empty', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('errors when a contract entry lacks coverage and exempt', () => {
    const result = checkCoverage(
      { routes: ['POST /api/worlds'], events: [], jobs: [] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('routes/POST /api/worlds')
    expect(result.errors[0]).toContain('not in coverage')
  })

  it('passes when a contract entry is covered', () => {
    const result = checkCoverage(
      { routes: ['POST /api/worlds'], events: [], jobs: [] },
      {
        version: 1,
        routes: ['POST /api/worlds'],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toEqual([])
  })

  it('passes when a contract entry is exempt with a valid reason', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: ['post-creation'] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: {
          routes: {},
          events: {},
          jobs: {
            'post-creation':
              'transitively exercised — barrier job fires automatically when per-player jobs complete',
          },
        },
      },
    )
    expect(result.errors).toEqual([])
  })

  it('errors when an exempt reason is too short', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: ['post-creation'] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: {
          routes: {},
          events: {},
          jobs: { 'post-creation': 'too short' },
        },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('exempt reason is too short')
  })

  it('warns when coverage contains an entry not in any contract (stale coverage)', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 1,
        routes: ['POST /api/worlds'],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('POST /api/worlds')
    expect(result.warnings[0]).toContain('no longer in contract')
  })

  it('errors when exempt contains an entry not in any contract (stale exempt)', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: {
          routes: { 'POST /api/old': 'a long-enough reason explaining the old exemption' },
          events: {},
          jobs: {},
        },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('exempt but no longer in contract')
  })

  it('errors when the coverage version is unrecognized', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 2 as unknown as 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('version')
  })
})
