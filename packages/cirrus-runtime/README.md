# @cirrus/runtime

Worker entry layer for the Cirrus framework. `createWorker({ shardDO, d1?, routes? })` returns a Cloudflare `fetch` handler that parses the Cirrus RPC envelope, resolves the target shard Durable Object via `idFromName`, forwards WebSocket upgrades, and mounts user-supplied HTTP routes (used by `cirrus-auth` for OAuth callbacks).
