<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="replica" />

</a>

<h3 align="center">Local-first replica runtime + local SQLite mirror for Lunora</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

> **Experimental** — this package is outside the Lunora 1.0 stability promise: its API may change in any release, without a major version bump.

<br />

<div align="center">

[![typescript-image][typescript-badge]][typescript-url]
[![FSL-1.1-Apache-2.0 licence][license-badge]][license]
[![npm version][npm-version-badge]][npm-version]
[![npm downloads][npm-downloads-badge]][npm-downloads]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]

</div>

---

<div align="center">
    <p>
        <sup>
            Daniel Bannert's open source work is supported by the community on <a href="https://github.com/sponsors/prisis">GitHub Sponsors</a>
        </sup>
    </p>
</div>

---

Local-first replica runtime and local SQLite mirror for [Lunora](https://lunora.sh).

**Events layer** — derive state from an append-only event log via reducers, persist
events through a Durable Object, and subscribe to typed events.

**Local mirror** — a client-side SQLite mirror that maintains a replica
of server tables by applying typed row-level diffs. Choose the SQLite backend
that fits your runtime:

| Backend                 | Entry point                               | Runtime                        |
| ----------------------- | ----------------------------------------- | ------------------------------ |
| sql.js (WASM)           | `@lunora/replica/adapters/sqljs`          | Browser, Node, Service Workers |
| better-sqlite3 (native) | `@lunora/replica/adapters/better-sqlite3` | Node.js                        |
| @sqlite.org/sqlite-wasm | `@lunora/replica/adapters/sqlite-wasm`    | Browser, Node (official WASM)  |
| Custom                  | Write your own `SqliteAdapter`            | Any                            |

## Install

```bash
pnpm add @lunora/replica
# Choose one SQLite backend:
pnpm add sql.js                       # browser + Node (WASM)
pnpm add better-sqlite3              # Node.js only (native)
pnpm add @sqlite.org/sqlite-wasm     # browser (official WASM)
# @lunora/server is optional — needed only for the EventLogDO:
pnpm add @lunora/server
```

## Exports

| Entry point                               | Contents                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@lunora/replica`                         | `EventSource`, `EventEmitter`, `defineEvents`, `defineMaterializer`, `EventLogDO`, `EventLogDOClient`, `SubscriptionManager`, `InMemorySnapshotStore`, `eventsContext`, `LocalMirror`, `EventLog`, `EventsSync`, `subscribeToMirror`, `applyDiff`, `TableDiff` helpers, `createSqlJsAdapter`, `createBetterSqlite3Adapter`, `createSqliteWasmAdapter` |
| `@lunora/replica/react`                   | `useLocalQuery` React hook                                                                                                                                                                                                                                                                                                                            |
| `@lunora/replica/adapters/sqljs`          | `createSqlJsAdapter` (sql.js)                                                                                                                                                                                                                                                                                                                         |
| `@lunora/replica/adapters/better-sqlite3` | `createBetterSqlite3Adapter` (better-sqlite3)                                                                                                                                                                                                                                                                                                         |
| `@lunora/replica/adapters/sqlite-wasm`    | `createSqliteWasmAdapter` (@sqlite.org/sqlite-wasm)                                                                                                                                                                                                                                                                                                   |

## EventSource

The core runtime — a typed reducer that derives state from an append-only log:

```ts
import { EventSource } from "@lunora/replica";

interface MyState {
    count: number;
    items: string[];
}

const source = new EventSource<MyState>({ count: 0, items: [] }, (state, entry) => {
    switch (entry.type) {
        case "item:added":
            return { count: state.count + 1, items: [...state.items, entry.payload as string] };
        default:
            return state;
    }
});

source.applyEvent("item:added", "hello");
console.log(source.state.count); // 1
```

## LocalMirror

An SQLite mirror that applies typed row-level diffs. Create it with your
chosen backend:

```ts
import initSqlJs from "sql.js";
import { createSqlJsAdapter, LocalMirror } from "@lunora/replica";

const SQL = await initSqlJs();
const adapter = createSqlJsAdapter(new SQL.Database());
const mirror = new LocalMirror({ db: adapter });

mirror.applyDiff({
    table: "todos",
    schema: "1.0",
    changes: [{ type: "insert", data: { id: "1", title: "hello", done: false } }],
});

const todos = mirror.query<{ id: string; title: string }>("SELECT id, title FROM todos");
```

For `better-sqlite3`:

```ts
import Database from "better-sqlite3";
import { createBetterSqlite3Adapter, LocalMirror } from "@lunora/replica";

const adapter = createBetterSqlite3Adapter(new Database(":memory:"));
const mirror = new LocalMirror({ db: adapter });
```

### EventsSync

Periodically polls a server-side event log, replays events through a state
machine, and pushes the resulting diffs to the mirror:

```ts
import { EventsSync } from "@lunora/replica";

const sync = new EventsSync({
    fetchEventsSince: (seq) => eventLogClient.getSince(seq),
    applyEvents: (events) => {
        /* feed events into your state machine */
    },
    getTableDiffs: () => {
        /* compare state before/after → TableDiff[] */
    },
    mirror,
    pollInterval: 3000,
});

sync.start(); // begin polling
// sync.sync(); // one-shot sync
// sync.stop(); // halt polling
```

See the [EventsSync JSDoc](src/sync-events.ts) for full API details.

### useLocalQuery (React)

Live-updating hook that re-queries the mirror whenever a diff is applied.
Returns `undefined` when the query fails (e.g. table doesn't exist yet),
and the result rows otherwise.

```tsx
import { useLocalQuery } from "@lunora/replica/react";

function TodoList() {
    const todos = useLocalQuery<{ id: string; title: string; done: boolean }>(mirror, "SELECT id, title, done FROM todos WHERE done = ?", [false]);

    if (todos === undefined) {
        return <p>Waiting for data…</p>;
    }

    return (
        <ul>
            {todos.map((t) => (
                <li key={t.id}>{t.title}</li>
            ))}
        </ul>
    );
}
```

The hook uses `useSyncExternalStore` under the hood, so it integrates with
React 18+ concurrent features and Suspense-based frameworks (Next.js, Remix).

## EventLogDO

A Durable Object that persists the event log to DO SQLite storage:

```ts
export { EventLogDO } from "@lunora/replica";

const client = new EventLogDOClient({ namespace: "my-app" });
await client.append({ type: "order:placed", payload: { orderId: "123" } });
const events = await client.query({ type: "order:placed", limit: 10 });
```

## Custom adapters

See the [custom adapter guide](docs/guides/custom-adapter.mdx) for writing
`SqliteAdapter` implementations for `expo-sqlite`, `bun:sqlite`, or any other
SQLite runtime.

## License

[FSL-1.1-Apache-2.0](./LICENSE.md)
