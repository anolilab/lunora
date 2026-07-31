/**
 * The runtime counterpart `_generated/shard.ts` imports to wrap `ctx.storage`.
 *
 * The implementation lives in `shared/as-bucket-storage.ts` because
 * `@lunora/runtime` needs the same tagging to build `ctx.storage` for an HTTP
 * action, and runtime must not gain a dependency on this package. Re-exported
 * here (unchanged) so the public `@lunora/server` surface and every generated
 * import site stay exactly as they were.
 */
export { asBucketStorage as default } from "../../../shared/as-bucket-storage";
