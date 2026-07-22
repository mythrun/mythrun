// backend/dev-tool/src/shell/workflow-registry.ts
//
// myth-0smu: workflow-per-page sidebar (replaces route-registry.ts).
// The dev-tool now has 6 entity-scoped pages instead of one panel per
// (endpoint × method). Each page composes the existing mountXxxPanel
// functions into a single scrolling column so contextually-related
// surfaces sit on the same page.
//
// This file is the declarative source-of-truth for the sidebar. The
// shell reads it to render leaves + mount the selected page. Page
// mount fns live in src/pages/*.ts and import the panels they compose
// directly — main.ts no longer needs per-panel side-effect imports.

import type { PanelHandle } from '../components/_shared/panel-skeleton.js'

export type WorkflowId =
  | 'campaigns'
  | 'world'
  | 'characters'
  | 'users'
  | 'billing'
  | 'system'

// The shell injects the mount fns at boot time via registerWorkflowMount
// so this module stays free of import-time dependencies on every page
// composer (otherwise tests that only need the static shape pay for the
// full panel graph). Sidebar render only needs id + title + requires-
// Campaign; mount is resolved lazily through the registry.

const WORKFLOW_MOUNTS = new Map<WorkflowId, (parent: HTMLElement) => PanelHandle>()

export function registerWorkflowMount(
  id: WorkflowId,
  fn: (parent: HTMLElement) => PanelHandle,
): void {
  WORKFLOW_MOUNTS.set(id, fn)
}

export function getWorkflowMount(
  id: WorkflowId,
): ((parent: HTMLElement) => PanelHandle) | undefined {
  return WORKFLOW_MOUNTS.get(id)
}

export interface WorkflowDescriptor {
  readonly id: WorkflowId
  readonly title: string
  readonly requiresCampaign: boolean
}

// Order is sidebar order. Campaigns first (the default landing page);
// World/Characters require an active campaign; Users/Billing/System
// are always selectable.
export const WORKFLOWS: readonly WorkflowDescriptor[] = [
  { id: 'campaigns', title: 'Campaigns', requiresCampaign: false },
  { id: 'world', title: 'World', requiresCampaign: true },
  { id: 'characters', title: 'Characters', requiresCampaign: true },
  { id: 'users', title: 'Users & Access', requiresCampaign: false },
  { id: 'billing', title: 'Billing & Credits', requiresCampaign: false },
  { id: 'system', title: 'System', requiresCampaign: false },
]
