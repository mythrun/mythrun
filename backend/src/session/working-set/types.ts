import type { AccessLevel } from '../../repo/facts.js' // 'known' | 'discoverable' | 'secret'

/**
 * Where a working-set fact came from, narratively.
 *
 * - `objective`: stated by the narration itself (true in-world).
 * - `attributed`: spoken/claimed by an NPC — may be a lie, rumor, or mistake.
 *   Carries the NPC's entity id + name so the reconciler can track who said it.
 */
export type WorkingSetProvenance =
  | { readonly kind: 'objective' }
  | { readonly kind: 'attributed'; readonly npcEntityId: string; readonly npcName: string }

/** A pre-embed proposal (FT delta / ST injection / retcon produce these). */
export interface WorkingSetProposal {
  readonly kind: 'fact' | 'entity' | 'relationship'
  readonly content: string
  readonly subjectName: string
  readonly edge?: { readonly fromName: string; readonly toName: string; readonly relType: string }
  readonly parentName?: string
  readonly tier: AccessLevel
  readonly provenance: WorkingSetProvenance
  readonly source: 'ft_delta' | 'st_injection' | 'retcon'
  readonly supersedesId?: string | null
  readonly supersededContent?: string
}

/** A working-set item = proposal + id, turnId, document embedding. */
export interface WorkingSetItem extends WorkingSetProposal {
  readonly id: string
  readonly turnId: string
  readonly embedding: readonly number[] // 512-dim Voyage DOCUMENT vector; [] on embed failure
}
