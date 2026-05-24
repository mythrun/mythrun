// backend/dev-tool/src/pages/users-page.ts
//
// myth-0smu: Users & Access workflow page. No active-campaign gate at
// the page level — individual invite panels gate themselves on the
// active campaign when the action requires it.

import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import { registerWorkflowMount } from '../shell/workflow-registry.js'
import { buildPageBody } from './_shared/page-skeleton.js'

import { mountUsersPanel } from '../components/users-panel.js'
import { mountInvitesPanel } from '../components/invites-panel.js'
import { mountInvitesListPanel } from '../components/invites-list-panel.js'
import { mountInviteRevokePanel } from '../components/invite-revoke-panel.js'
import { mountInvitePreviewPanel } from '../components/invite-preview-panel.js'
import { mountInviteAcceptPanel } from '../components/invite-accept-panel.js'

const SECTIONS: readonly {
  readonly id: string
  readonly mount: (parent: HTMLElement) => PanelHandle
}[] = [
  { id: 'users', mount: mountUsersPanel },
  { id: 'invites', mount: mountInvitesPanel },
  { id: 'invites-list', mount: mountInvitesListPanel },
  { id: 'invite-revoke', mount: mountInviteRevokePanel },
  { id: 'invite-preview', mount: mountInvitePreviewPanel },
  { id: 'invite-accept', mount: mountInviteAcceptPanel },
]

export function mountUsersPage(parent: HTMLElement): PanelHandle {
  const body = buildPageBody(parent, 'Users & Access')
  for (const s of SECTIONS) {
    body.mountSection(s.id, s.mount)
  }
  return {
    root: body.root,
    unmount: () => {
      body.unmountAll()
      if (body.root.parentNode !== null) body.root.parentNode.removeChild(body.root)
    },
  }
}

registerWorkflowMount('users', mountUsersPage)
