// ESM resolve/load hooks that make the deployed CloudFront Function source
// (functions/basic-auth.js) importable + unit-testable under plain Node:
//   1. Virtualize the runtime-only `cloudfront` module. Its kvs().get() reads
//      test-controlled state from globalThis.__CF_KVS_STATE__:
//        { 'staging-basic-auth': '<expected header>' } -> returns it
//        { throw: true }                                -> throws (KVS down)
//        {}                                             -> throws KeyNotFound (key unset)
//   2. Append `export { handler }` to basic-auth.js AT LOAD TIME ONLY, so the
//      on-disk deployed artifact stays export-free (the CloudFront runtime
//      invokes the module-global `handler`, it does not import an export).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const VIRTUAL = 'virtual:cloudfront.mjs';

export async function resolve(specifier, context, next) {
  if (specifier === 'cloudfront') {
    return { url: VIRTUAL, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === VIRTUAL) {
    const source = `const cf = { kvs: () => ({ get: async (key) => {
      const s = globalThis.__CF_KVS_STATE__ || {};
      if (s.throw) throw new Error('KVS unavailable');
      if (Object.prototype.hasOwnProperty.call(s, key)) return s[key];
      throw new Error('KeyNotFound');
    } }) }; export default cf;`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/basic-auth.js')) {
    const original = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: original + '\nexport { handler };\n', shortCircuit: true };
  }
  return next(url, context);
}
