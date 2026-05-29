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
- `ScheduledJobs` — view (and optionally cancel) functions queued via
  `runAfter` / `runAt`.

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
over the admin-RPC path. Wire `ScheduledJobs` (or `Dashboard`'s `scheduledLoad` /
`scheduledCancel`) to your admin-gated `SchedulerDO` endpoints — `GET /list`
returns `{ records: ScheduleRecord[] }`, `POST /cancel` takes `{ id }`:

```tsx
import { Dashboard } from "@cirrus/dashboard";

<Dashboard
    functions={functions}
    scheduledLoad={async () => {
        const response = await fetch("/admin/scheduler/list", { headers: { authorization: `Bearer ${token}` } });

        return (await response.json()).records;
    }}
    scheduledCancel={async (id) => {
        const response = await fetch("/admin/scheduler/cancel", {
            body: JSON.stringify({ id }),
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            method: "POST",
        });

        return response.json();
    }}
/>;
```
