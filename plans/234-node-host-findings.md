# Node Host Implementation - Findings (Plan 234)

## Status: Workflow + R2 adapters implemented, tests passing

### What works

- `createNodeR2Bucket` — fs-backed `R2BucketLike` (put/get/head/delete/list, ranges, checksums, cursor paging)
- `createNodeWorkflowHost` — visulima-backed workflow host (bindings/env/runtime, step adapter, status mapping)
- Both modules exported from `@lunora/platform-node`
- `NODE_CAPABILITIES` updated: workflows + objectStorage = `emulated`
- `packages/config/src/node/node-driver.ts` trimmed: queues + containers remain `UNSUPPORTED`
- All 92 tests pass (including 10 new tests for R2 and workflow hosts)

### Known gaps

- **Workflows**: pause/restart not implemented (visulima has no equivalent); `create({ id })` throws `NOT_IMPLEMENTED` (the engine mints run ids and takes no override); `ctx.run` fails (no Node HTTP server); `ctx.parallel` join can't interleave in one trigger. Restart durability is closed — `store` is required and `createNodeWorkflowStore` is a SQLite `WorkflowStore`
- **Object Storage**: no multipart upload; no presigned URLs; `createNodeR2Bucket` is fs-backed (not production-durable)

### Remaining lint issues (node-r2-bucket.ts)

Pre-existing and new lint errors in `node-r2-bucket.ts` need fixing:

- `jsdoc/check-indentation` — header doc indentation
- `import/exports-last` — export statements mid-file
- `sonarjs/no-nested-conditional` — ternary chain in `put` method
- `unicorn/prevent-abbreviations` — `dir`, `rel` variable names
- `no-await-in-loop` — `await` inside loop in `list` method
- `sonarjs/no-alphabetical-sort` — `sort()` without compare function
- `no-bitwise` — `>>` operator usage
- `unicorn/no-null` — `null` instead of `undefined`
- `require-await` — async methods without `await`
- `prefer-optional-chain` — optional chaining opportunity

### Next steps

1. Fix node-r2-bucket.ts lint errors (tracked separately)
2. Add integration tests for edge cases (large files, concurrent writes)
3. Document the emulated capabilities in user-facing docs
4. Consider adding a durable store option for workflows (e.g., SQLite-backed `WorkflowStore`)
