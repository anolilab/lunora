# Node Host Implementation - Findings (Plan 234)

## Status: Workflow + R2 adapters implemented, tests passing

### What works

- `createNodeR2Bucket` — fs-backed `R2BucketLike` (put/get/head/delete/list, ranges, checksums, cursor paging)
- `createNodeWorkflowHost` — visulima-backed workflow host (bindings/env/runtime, step adapter, status mapping)
- Both modules exported from `@lunora/platform-node`
- `NODE_CAPABILITIES` updated: workflows + objectStorage = `emulated`
- `packages/config/src/node/node-driver.ts` trimmed: queues + containers remain `UNSUPPORTED`
- All 109 tests pass (37 of them in the R2, workflow-host and workflow-store suites)

### Known gaps

- **Workflows**: pause/restart not implemented (visulima has no equivalent); `create({ id })` is honoured via a durable alias row rather than passed to the engine, which mints its own run ids; `terminate` is not a barrier, so an in-flight activation overwrites the tombstone; `ctx.run` fails (no Node HTTP server); `ctx.parallel` join can't interleave in one trigger. Restart durability is closed — `store` is required and `createNodeWorkflowStore` is a SQLite `WorkflowStore`
- **Object Storage**: no multipart upload; no presigned URLs; `createNodeR2Bucket` is fs-backed (not production-durable)

### Why the R2 layout is one file, not a sidecar tree

The first design stored object bytes at `directory/key` and metadata beside them
at `directory/.lunora-meta/key.json`. Two files, and no pair of filesystem
operations publishes both at once — so a crash between the body rename and the
sidecar write left new bytes carrying the previous checksum, size and
content-type, which `get`/`head` then reported as fact.

The structural cost was larger than the crash window. Because a sidecar can
always be missing, every read carried a "fall back to `stat`" path:
`getUploadedDate`, `statObject`, and a `toObject(key, meta | undefined,
fileStat?)` that fabricated an etag (`stat-<size>-<mtime>`) and an undefined
checksum for anything it could not explain — including a file that was never one
of ours. Writing metadata before the body rename plus a size cross-check would
have narrowed the window without removing that branch.

The trailer removes both: an object is exactly one file with a valid trailer,
`readTrailerFrom` is total, and `toObject` takes a required `NodeObjectMeta`.
Three helpers and one optional parameter went with it.

### Next steps

1. Document the emulated capabilities in user-facing docs
2. Percent-encode key segments if case-insensitive-filesystem folding (`A` vs
   `a`) ever needs to stop being a divergence from real R2
