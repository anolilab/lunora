# @cirrus/dashboard

Embeddable React components for inspecting and operating a Cirrus backend.

The package is a component library — compose the panels yourself behind a
`<CirrusProvider>`, mount the ready-made `<Dashboard>` shell, or use the
batteries-included `<DashboardApp>` / `mountDashboard` entry.

## Running the dashboard

Three ways, smallest setup first:

1. **`cirrus dev` (zero config).** The `@cirrus/vite` plugin serves the
   dashboard at **`/__cirrus`** during dev and prints the URL on startup. Add
   `@cirrus/dashboard` to your project's deps and it just works; opt out with
   `cirrus({ dashboard: false })`.
2. **Standalone app.** `apps/dashboard` (`@cirrus/dashboard-app`) is a deployable
   Vite SPA that points at any worker via `VITE_CIRRUS_URL` — for hosting the
   dashboard separately from dev.
3. **Embed.** Mount `<DashboardApp baseUrl="…" />` (self-contained: builds the
   client, manages the admin token) or compose individual panels under your own
   `<CirrusProvider>`.

```ts
// mount the whole app into a <div id="root">
import { mountDashboard } from "@cirrus/dashboard/mount";

mountDashboard({ baseUrl: "https://my-app.workers.dev" });
```

## Components

- `Dashboard` — a tabbed shell that composes every panel below behind one
  provider. Tabs whose data source isn't configured are omitted.
- `DataBrowser` — list a shard's tables and page through their rows, with a
  table/JSON view toggle, refresh, and a whole-table search box (a debounced
  server-side substring filter across every column, paginated over the matched
  set — not just the loaded page). Column sorting stays page-local.
- `GlobalDataBrowser` — the same, for `.global()` (D1-backed) tables.
- `SchemaViewer` — every table with its row count, expandable to its columns.
- `FunctionRunner` — pick a registered function, edit its JSON args, and invoke
  it (query / mutation / action), showing the result or error. Auto-discovers the
  function list from the worker; pass an explicit `FunctionDescriptor[]` to skip
  discovery.
- `MetricsPanel` — per-shard health: request/error counts, uptime, DB size, and
  reactive-cache hit rate.
- `MigrationsPanel` — inspect data-migration run-state and kick off a migration
  by id (direction, dry-run).
- `ExportImportPanel` — snapshot a shard to NDJSON and restore NDJSON back.
- `FileBrowser` — page through objects in the storage (R2) bucket by prefix.
- `ScheduledJobs` — view and cancel functions queued via `runAfter` / `runAt`.
- `UsersPanel` — browse auth users and drill into a user's sessions (read-only).

## Admin gate

Every panel except `FunctionRunner` and `ScheduledJobs` reaches the backend via
reserved `__cirrus_admin__:*` RPCs that `ShardDO` intercepts. Those are
**disabled unless the server sets `CIRRUS_ADMIN_TOKEN`**, and the client must
present a matching `Authorization: Bearer` token. Configure the client's auth
token at the host — these components issue no credentials of their own.

## Live updates

The **Metrics**, **Logs**, **Data browser**, and **Migrations** panels each
expose a **Live** toggle. When on, the panel opens a `__cirrus_admin__:*`
WebSocket subscription that re-pushes whenever the shard changes — the data
browser is scoped to the loaded table (and also re-pushes its table list, so a
migration that creates a table shows up without a manual reload), the others
refresh on any write-flush (e.g. a long migration's processed/changed counts
climb mid-run). With Live off, the panels stay one-shot (load + manual
**Refresh**).

The HTTP-backed panels read through admin endpoints over D1, the SessionDO, the
SchedulerDO and R2 — backends with no subscription channel — so they can't use
the WebSocket push above. **Scheduled jobs** and **Users** instead offer an
**Auto** toggle that polls on an interval (`useAutoRefresh`, paused while the
tab is hidden). For the scheduler this is the right model, not a compromise:
jobs fire on wall-clock time, so polling lets you watch them count down and
disappear as their alarms fire — there's no write event for a server to push.
True server-pushed updates for these would require replicating the ShardDO
subscription infrastructure into each backend DO.

A **connection badge** in the header reflects the client's aggregate live-socket
health (idle / connecting / connected / offline) via `useConnectionStatus`, so
"Live: on" with a dropped socket is distinguishable from a genuinely idle panel.
The shell also wraps each tab in an error boundary (one panel throwing won't
blank the others) and persists the admin token in `sessionStorage` (cleared via
the header's **Clear** button) so a reload doesn't force a re-paste.

Destructive actions — deleting a row, running a non-dry-run migration,
cancelling a scheduled job, and importing rows — require a second confirming
click (an inline `Confirm` / `Cancel` step, not a blocking dialog) via the
exported `<ConfirmButton>`.

Every shard-scoped panel's shard-key field is a shared `<ShardInput>` backed by
a recently-used-shards autocomplete (`sessionStorage`). Durable Objects aren't
externally enumerable, so the dashboard can't list shards server-side; instead it
remembers the shards you actually open and offers them as a `<datalist>` — the
practical substitute for a shard picker.

`DashboardApp` ships a scoped stylesheet (`<DashboardStyles>`, every rule under
`.cirrus-dashboard-root`) with a light/dark theme via `prefers-color-scheme` and
a responsive header/table layout — so it never leaks styles into a host page. If
you compose panels by hand, render `<DashboardStyles>` under a
`.cirrus-dashboard-root` wrapper (both are exported) to opt in, or bring your own
CSS.

Live updates ride the **same `CIRRUS_ADMIN_TOKEN`** as the HTTP admin RPCs. A
browser `WebSocket` can't send an `Authorization` header, so the dashboard sends
the admin token as the client's [`wsToken`](../client/README.md), which the
server matches on the upgrade to authorize the admin socket. The standalone
`DashboardApp` wires this for you; if you compose panels under your own
provider, construct the client with `wsToken: env.CIRRUS_ADMIN_TOKEN`. Because
the token lands in the WS URL (and thus server logs), prefer a short-lived
rotating token in production. Without it, the subscription is rejected and the
panel shows a "Live unavailable" notice while the one-shot view keeps working.

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

### Function discovery

`FunctionRunner` auto-discovers the function list via the client's
`listFunctions()`, which hits the admin-gated `GET /_cirrus/admin/functions`
endpoint. Pass the generated `CIRRUS_FUNCTIONS` registry to the worker (internal
functions are filtered out server-side):

```ts
import { CIRRUS_FUNCTIONS } from "./cirrus/_generated/server.js";

createWorker({
    shardDO: env.SHARD,
    adminToken: env.CIRRUS_ADMIN_TOKEN,
    functions: CIRRUS_FUNCTIONS,
});
```

To skip discovery (or expose a curated subset), pass the list directly:

```tsx
<FunctionRunner functions={[{ kind: "query", path: "messages:list" }]} />
```

### Global (D1) tables

`GlobalDataBrowser` reads `.global()` tables — which live in D1, not the shard
DOs — via the client's `listGlobalTables()` / `readGlobalTablePage()`, hitting
the admin-gated `/_cirrus/admin/global/*` endpoints. Build a `globalIntrospector`
from `@cirrus/d1` over your D1 binding and your schema:

```ts
import { listGlobalTables, readGlobalTablePage } from "@cirrus/d1";
import schema from "./cirrus/schema.js";

const exec = {
    all: (sql, params) =>
        env.DB.prepare(sql)
            .bind(...params)
            .all()
            .then((r) => r.results),
    run: (sql, params) =>
        env.DB.prepare(sql)
            .bind(...params)
            .run()
            .then(() => undefined),
};

createWorker({
    shardDO: env.SHARD,
    adminToken: env.CIRRUS_ADMIN_TOKEN,
    globalIntrospector: {
        listTables: () => listGlobalTables(exec, schema),
        readTablePage: (opts) => readGlobalTablePage(exec, schema, opts),
    },
});
```

### Users & sessions

`UsersPanel` reads better-auth's `user` / `session` tables (read-only) via the
client's `listAuthUsers()` / `listAuthSessions()`, hitting the admin-gated
`/_cirrus/admin/auth/*` endpoints. Build an `authIntrospector` that selects only
non-sensitive identity columns — never password hashes or tokens:

```ts
createWorker({
    shardDO: env.SHARD,
    adminToken: env.CIRRUS_ADMIN_TOKEN,
    authIntrospector: {
        // SELECT id, name, email, emailVerified, createdAt FROM "user" …
        listUsers: (options) => readUsers(options),
        // SELECT id, userId, expiresAt, ipAddress, userAgent FROM "session" …
        listSessions: (options) => readSessions(options),
    },
});
```
