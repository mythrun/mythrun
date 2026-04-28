import { extractSchema } from './schemaExtractor.ts'
import { renderSchema } from './schemaRenderer.ts'

export interface BuildSchemaFragmentOptions {
  readonly databaseUrl: string
  readonly migrationsDir: string
}

/** Returns the HTML fragment to splice at the <!-- @schema-reference --> marker. */
export async function buildSchemaFragment(opts: BuildSchemaFragmentOptions): Promise<string> {
  const meta = await extractSchema(opts)
  return renderSchema(meta)
}
