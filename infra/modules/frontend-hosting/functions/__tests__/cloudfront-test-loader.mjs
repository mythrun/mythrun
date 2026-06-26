// Registers the resolve/load hook in the loader thread. Passed to node via
// `--import`. Path is relative to THIS file.
import { register } from 'node:module';

register('./cloudfront-resolve-hook.mjs', import.meta.url);
