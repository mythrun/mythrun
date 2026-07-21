import { Heading, Text, Button } from '@mythrun/ui'
import { entriesByKey } from './store.ts'
import { inferRole } from './flows.ts'
import { T } from './highlight.tsx'

/** The fallback exhibit for a key with no bespoke scene: the live copy rendered in
 *  a faithful DS type role on the real token ground. Not a cop-out — it uses the
 *  real Heading / Text / Button roles, repaints on override, and highlights on
 *  focus — it just doesn't reconstruct the full surrounding screen. */
export function ContextCard({ keys }: { keys: string[] }): React.JSX.Element {
  return (
    <div className="wb-ctx">
      {keys.map((k) => {
        const entry = entriesByKey[k]
        if (!entry) return null
        const role = inferRole(entry)
        return (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
            <span className="wb-ctx-role">{role.label}</span>
            {role.tag === 'heading' ? (
              <Heading level={role.level} role={role.role}>
                <T k={k} />
              </Heading>
            ) : role.tag === 'button' ? (
              <div>
                <Button variant="secondary" onPress={() => undefined}>
                  <T k={k} />
                </Button>
              </div>
            ) : (
              <Text role={role.role}>
                <T k={k} />
              </Text>
            )}
          </div>
        )
      })}
    </div>
  )
}
