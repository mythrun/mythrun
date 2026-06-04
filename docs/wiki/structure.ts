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
      { slug: 'smoke-testing', title: 'Smoke testing' },
    ],
  },
  {
    slug: 'runtime',
    title: 'Runtime',
    pages: [
      { slug: 'index', title: 'Overview' },
      { slug: 'llm', title: 'LLM client' },
      { slug: 'dev-tool', title: 'Dev tool' },
      { slug: 'worker', title: 'Worker' },
      { slug: 'world-gen', title: 'World gen' },
      { slug: 'character-creation', title: 'Character creation' },
      { slug: 'character-integration', title: 'Character integration' },
      { slug: 'session-prep', title: 'Session prep' },
      { slug: 'pipeline-status', title: 'Pipeline status' },
      { slug: 'session-transport', title: 'Session transport' },
    ],
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
      { slug: 'jwt-middleware', title: 'JWT middleware' },
      { slug: 'onboarding', title: 'Onboarding & invites' },
      { slug: 'access-control-ws-ticket', title: 'Access control & WS ticket' },
      { slug: 'stripe-contract', title: 'Stripe contract' },
      { slug: 'billing-webhook', title: 'Billing webhook' },
      { slug: 'billing-routes', title: 'Billing routes' },
      { slug: 'billing-metering', title: 'Billing metering' },
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
