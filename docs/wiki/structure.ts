import type { Section } from './build/types.ts'

export const structure: Section[] = [
  {
    slug: 'infra',
    title: 'Infra',
    pages: [
      { slug: 'index', title: 'Overview' },
      { slug: 'network', title: 'Network' },
      { slug: 'data', title: 'Data plane' },
      { slug: 'dns', title: 'DNS' },
      { slug: 'serving', title: 'Serving' },
      { slug: 'ci-cd', title: 'CI/CD' },
    ],
  },
  {
    slug: 'runtime',
    title: 'Runtime',
    pages: [{ slug: 'index', title: 'Overview' }],
  },
  {
    slug: 'data',
    title: 'Data',
    pages: [
      { slug: 'index', title: 'Overview' },
      { slug: 'schema', title: 'Schema' },
      { slug: 'migrations', title: 'Migrations' },
      { slug: 'repository', title: 'Repository layer' },
      { slug: 'bootstrap-database', title: 'Bootstrap database' },
    ],
  },
  {
    slug: 'auth-billing',
    title: 'Auth & Billing',
    pages: [
      { slug: 'index', title: 'Overview' },
      { slug: 'identity', title: 'Identity' },
    ],
  },
  {
    slug: 'world-campaign',
    title: 'World & Campaign',
    pages: [{ slug: 'index', title: 'Overview' }],
  },
  {
    slug: 'combat',
    title: 'Combat',
    pages: [{ slug: 'index', title: 'Overview' }],
  },
  {
    slug: 'frontend',
    title: 'Frontend',
    pages: [{ slug: 'index', title: 'Overview' }],
  },
  {
    slug: 'reference',
    title: 'Reference',
    pages: [
      { slug: 'index', title: 'Overview' },
      { slug: 'runbooks', title: 'Runbooks' },
      { slug: 'schema', title: 'Schema reference' },
    ],
  },
]
