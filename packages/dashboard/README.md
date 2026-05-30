# @cirrus/dashboard

Embeddable React components for inspecting and operating a Cirrus backend.

The package is a component library — drop the pieces into your own admin route
behind a `<CirrusProvider>`; there is no standalone server or app. Compose the
panels yourself, or mount the ready-made `<Dashboard>` shell.

## Components

- `Dashboard` — a tabbed shell that composes every panel below behind one
  provider. Tabs whose data source isn't configured are omitted.
- `DataBrowser` — list a shard's tables and page through their rows, with a
  table/JSON view toggle and refresh.
- `SchemaViewer` — every table with its row count, expandable to its columns.
- `FunctionRunner` — pick a registered function, edit its JSON args, and invoke
  it (query / mutation / action), showing the result or error. Pass the set of
  functions to expose as `FunctionDescriptor[]`.
- `MigrationsPanel` — inspect data-migration run-state and kick off a migration
  by id (direction, dry-run).
- `ExportImportPanel` — snapshot a shard to NDJSON and restore NDJSON back.
- `FileBrowser` — page through objects in the storage (R2) bucket by prefix.
- `ScheduledJobs` — view and cancel functions queued via `runAfter` / `runAt`.

## Admin gate

Every panel except `FunctionRunner` and `ScheduledJobs` reaches the backend via
reserved `__cirrus_admin__:*` RPCs that `ShardDO` intercepts. Those are
**disabled unless the server sets `CIRRUS_ADMIN_TOKEN`**, and the client must
present a matching `Authorization: Bearer` token. Configure the client's auth
token at the host — these components issue no credentials of their own.

## Usage

```tsx
import { CirrusProvider } from "@cirrus/react";
import { Dashboard } from "@cirrus/dashboard";

const functions = [
    { kind: "query", path: "messages:list" },
    { kind: "mutation", path: "messages:send" },
];

<CirrusProvider client={client}>
    <Dashboard functions={functions} />
</CirrusProvider>;
```

Or mount a single panel:

```tsx
import { DataBrowser, FunctionRunner } from "@cirrus/dashboard";

<CirrusProvider client={client}>
    <DataBrowser initialShardKey="room-42" />
    <FunctionRunner functions={functions} />
</CirrusProvider>;
```

### Scheduled jobs

The scheduler is a distinct Durable Object from the shards, so it isn't reachable
over the per-shard admin-RPC path. Instead, the worker exposes admin-gated
`/_cirrus/admin/scheduled` endpoints, and the client's `listScheduledJobs()` /
`cancelScheduledJob(id)` methods call them — so `ScheduledJobs` (and the
`Dashboard` schedule tab) work out of the box under `<CirrusProvider>` with no
extra wiring.

Two things must be configured server-side for the endpoints to answer:

```ts
// worker entry
createWorker({
    shardDO: env.SHARD,
    schedulerDO: env.SCHEDULER, // same namespace you pass to createScheduler
    adminToken: env.CIRRUS_ADMIN_TOKEN, // gates every admin endpoint
});
```

To source jobs from somewhere else (or render a read-only list), override the
loader/canceller:

```tsx
<ScheduledJobs
    loadJobs={async () => myRecords} // omit cancelJob for a read-only view
/>
```

### File browser

`FileBrowser` lists R2 objects through the client's `listStorageObjects()`, which
hits the admin-gated `GET /_cirrus/admin/storage` endpoint. Pass a `storageList`
function to the worker (the structural shape matches `createStorage(...).list`):

```ts
import { createStorage } from "@cirrus/storage";

createWorker({
    shardDO: env.SHARD,
    adminToken: env.CIRRUS_ADMIN_TOKEN,
    storageList: createStorage({ bucket: env.FILES }).list,
});
```
