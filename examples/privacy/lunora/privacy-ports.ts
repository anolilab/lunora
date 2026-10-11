/**
 * The privacy package's ports, bound to Lunora's database.
 *
 * `localPorts` runs inside a mutation or a query, where `ctx.db` exists. A workflow has
 * no `ctx.db`: its steps reach the database through `ctx.run` into the internal
 * `privacyPort` mutation, which calls `dispatchPort` with the same local ports. The wire
 * format is JSON with tagged values, so a `Date`, a `Set`, a byte array and `undefined`
 * survive the hop.
 */
import type { DataPort, Dataset, PrivacyPorts, RequestRecord, RequestStore, StorePort } from "@lunora/privacy";
import { ERASE_BATCH, isTerminal } from "@lunora/privacy";
import type { WorkflowRunContext } from "@lunora/workflow";
import { LunoraError } from "lunorash/errors";

import type { Doc as Document_ } from "./_generated/dataModel.js";
import { internal } from "./_generated/internal.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

type RequestRow = Document_<"privacy_requests">;

/** A query can read the ports but not write them; a mutation can do both. */
type LocalContext = MutationCtx | QueryCtx;

/** Every status except the two terminal ones, which `isTerminal` names. */
const OPEN_STATUSES: ReadonlyArray<RequestRow["status"]> = ["received", "grace", "processing", "ready", "failed"];

const requireTasks = (dataset: Dataset): void => {
    if (dataset.id !== "tasks") {
        throw new LunoraError("INTERNAL", `privacy-example has no reader for dataset "${dataset.id}".`);
    }
};

/** A stored request, as the package sees it: dates are `Date`s. */
const toRecord = (row: RequestRow): RequestRecord => {
    return {
        dueAt: new Date(row.dueAt),
        id: row.requestId,
        receivedAt: new Date(row.receivedAt),
        status: row.status,
        subjectId: row.subjectId,
        type: row.type,
        ...(row.erasureGraceUntil === undefined ? {} : { erasureGraceUntil: new Date(row.erasureGraceUntil) }),
        ...(row.expiresAt === undefined ? {} : { expiresAt: new Date(row.expiresAt) }),
        ...(row.extendedDueAt === undefined ? {} : { extendedDueAt: new Date(row.extendedDueAt) }),
        ...(row.reason === undefined ? {} : { reason: row.reason }),
        ...(row.storageKey === undefined ? {} : { storageKey: row.storageKey }),
    };
};

/** Only the keys the package sets, so an unset optional stays unset rather than becoming `undefined`. */
const toPatch = (patch: Partial<Omit<RequestRecord, "id">>): Partial<Omit<RequestRow, "_id" | "_creationTime" | "requestId">> => {
    return {
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.dueAt === undefined ? {} : { dueAt: patch.dueAt.getTime() }),
        ...(patch.receivedAt === undefined ? {} : { receivedAt: patch.receivedAt.getTime() }),
        ...(patch.erasureGraceUntil === undefined ? {} : { erasureGraceUntil: patch.erasureGraceUntil.getTime() }),
        ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt.getTime() }),
        ...(patch.extendedDueAt === undefined ? {} : { extendedDueAt: patch.extendedDueAt.getTime() }),
        ...(patch.reason === undefined ? {} : { reason: patch.reason }),
        ...(patch.storageKey === undefined ? {} : { storageKey: patch.storageKey }),
    };
};

/** The writer for this call. A query has none, so a write from one throws instead of silently dropping. */
const writerOf = (ctx: LocalContext): MutationCtx["db"] => {
    if (!("insert" in ctx.db)) {
        throw new LunoraError("BAD_REQUEST", "This call reads privacy data and cannot write it.");
    }

    return ctx.db;
};

const rowFor = async (ctx: LocalContext, requestId: string): Promise<RequestRow | undefined> =>
    (await ctx.db
        .query("privacy_requests")
        .withIndex("byRequestId", (q) => q.eq("requestId", requestId))
        .first()) ?? undefined;

const requestStore = (ctx: LocalContext): RequestStore => {
    return {
        addEvent: async (requestId, at, kind, detail) => {
            await writerOf(ctx).insert("privacy_events", { at: at.getTime(), kind, requestId, ...(detail === undefined ? {} : { detail }) });
        },
        findOpen: async (subjectId, type) => {
            const rows = await ctx.db
                .query("privacy_requests")
                .withIndex("bySubject", (q) => q.eq("subjectId", subjectId).eq("type", type))
                .collect();
            const open = rows.find((row) => !isTerminal(row.status));

            return open === undefined ? undefined : toRecord(open);
        },
        get: async (id) => {
            const row = await rowFor(ctx, id);

            return row === undefined ? undefined : toRecord(row);
        },
        insert: async (record) => {
            await writerOf(ctx).insert("privacy_requests", {
                dueAt: record.dueAt.getTime(),
                progress: 0,
                receivedAt: record.receivedAt.getTime(),
                requestId: record.id,
                status: record.status,
                subjectId: record.subjectId,
                type: record.type,
                ...(record.erasureGraceUntil === undefined ? {} : { erasureGraceUntil: record.erasureGraceUntil.getTime() }),
            });
        },
        listOpen: async () => {
            // Read per open status through the status index, so the sweep never scans the table.
            const batches = await Promise.all(
                OPEN_STATUSES.map(async (status) =>
                    ctx.db
                        .query("privacy_requests")
                        .withIndex("byStatus", (q) => q.eq("status", status))
                        .collect(),
                ),
            );

            return batches.flat().map((row) => toRecord(row));
        },
        update: async (id, patch) => {
            const row = await rowFor(ctx, id);

            if (row !== undefined) {
                await writerOf(ctx).patch(row._id, toPatch(patch));
            }
        },
    };
};

const dataPort = (ctx: LocalContext): DataPort => {
    return {
        collect: async (dataset, subjectId) => {
            requireTasks(dataset);

            const rows = await ctx.db
                .query("tasks")
                .withIndex("byUser", (q) => q.eq("userId", subjectId))
                .collect();

            return {
                tasks: rows.map((row) => {
                    return { ...row };
                }),
            };
        },
        eraseBatch: async (dataset, subjectId) => {
            requireTasks(dataset);

            const rows = await ctx.db
                .query("tasks")
                .withIndex("byUser", (q) => q.eq("userId", subjectId))
                .take(ERASE_BATCH);

            const database = writerOf(ctx);

            await Promise.all(rows.map(async (row) => database.delete(row._id)));

            return { hasMore: rows.length === ERASE_BATCH };
        },
        remaining: async (dataset, subjectId) => {
            requireTasks(dataset);

            const rows = await ctx.db
                .query("tasks")
                .withIndex("byUser", (q) => q.eq("userId", subjectId))
                .collect();

            return { tasks: rows.length };
        },
    };
};

/**
 * Export parts and the archive are kept in `exportFiles`. This example has no object
 * storage, so `signedUrl` returns a path that is not served yet; see the README.
 */
const filePort = (ctx: LocalContext): StorePort => {
    return {
        put: async (requestId, file) => {
            const isText = typeof file.data === "string";
            const body = typeof file.data === "string" ? file.data : Buffer.from(file.data).toString("base64");
            const encoding = isText ? "text" : "base64";
            const existing =
                (await ctx.db
                    .query("exportFiles")
                    .withIndex("byRequestAndName", (q) => q.eq("requestId", requestId).eq("name", file.name))
                    .first()) ?? undefined;

            await (existing === undefined
                ? writerOf(ctx).insert("exportFiles", { body, encoding, name: file.name, requestId })
                : writerOf(ctx).patch(existing._id, { body, encoding }));

            return `${requestId}/${file.name}`;
        },
        read: async (requestId, name) => {
            const row =
                (await ctx.db
                    .query("exportFiles")
                    .withIndex("byRequestAndName", (q) => q.eq("requestId", requestId).eq("name", name))
                    .first()) ?? undefined;

            return row?.encoding === "text" ? row.body : undefined;
        },
        signedUrl: (key, ttlSeconds) => Promise.resolve(`/privacy/files/${key}?expires_in=${String(ttlSeconds)}`),
    };
};

const tombstonePort = (ctx: LocalContext): Tombstones => {
    return {
        add: async (key, erasedAt) => {
            await writerOf(ctx).insert("privacy_tombstones", { erasedAt: erasedAt.getTime(), scope: "subject", subjectKey: key });
        },
        keys: async () => {
            const rows = await ctx.db.query("privacy_tombstones").collect();

            return new Set(rows.map((row) => row.subjectKey));
        },
    };
};

/** The ports for one call: a mutation's, a query's (reads only), or the workflow's dispatcher. */
export const localPorts = (ctx: LocalContext): PrivacyPorts => {
    return {
        data: dataPort(ctx),
        files: filePort(ctx),
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
        store: requestStore(ctx),
        tombstones: tombstonePort(ctx),
    };
};

/**
 * Dates, sets, byte arrays and `undefined` get a tagged object so JSON can carry them.
 * `undefined` matters inside an argument list: JSON turns it into `null`, which a
 * validator then refuses where the argument is optional.
 */
const toWire = (value: unknown): unknown => {
    if (value === undefined) {
        return { $undefined: true };
    }

    if (value instanceof Date) {
        return { $date: value.toISOString() };
    }

    if (value instanceof Set) {
        return { $set: [...value] };
    }

    if (value instanceof Uint8Array) {
        return { $bytes: Buffer.from(value).toString("base64") };
    }

    if (Array.isArray(value)) {
        return value.map((item) => toWire(item));
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toWire(item)]));
    }

    return value;
};

/** Decodes one tag written by `toWire`. A key that is not a tag is an ordinary object key. */
const TAG_DECODERS: Readonly<Record<string, (inner: unknown) => unknown>> = {
    $bytes: (inner) => new Uint8Array(Buffer.from(String(inner), "base64")),
    $date: (inner) => new Date(String(inner)),
    $set: (inner) => new Set(Array.isArray(inner) ? inner : []),
    $undefined: () => undefined,
};

const fromWire = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => fromWire(item));
    }

    if (value === null || typeof value !== "object") {
        return value;
    }

    const entries = Object.entries(value);
    const [tag, inner] = entries.length === 1 ? (entries[0] ?? []) : [];

    if (tag !== undefined && Object.hasOwn(TAG_DECODERS, tag)) {
        return TAG_DECODERS[tag](inner);
    }

    return Object.fromEntries(entries.map(([key, item]) => [key, fromWire(item)]));
};

/** The tombstone port, or a loud failure: `restore` needs it, and a call without it must not look like success. */
type Tombstones = NonNullable<PrivacyPorts["tombstones"]>;

const requireTombstones = (ports: PrivacyPorts): Tombstones => {
    if (ports.tombstones === undefined) {
        throw new LunoraError("INTERNAL", "tombstones are not bound for this call.");
    }

    return ports.tombstones;
};

/**
 * One port method, reached by name. The arguments arrive from the wire as `unknown`, so
 * each entry reads them by position and types them once, here.
 */
type PortCall = (ports: PrivacyPorts, values: ReadonlyArray<unknown>) => Promise<unknown>;

const PORT_CALLS: Readonly<Record<string, PortCall>> = {
    "data.collect": (ports, values) => ports.data.collect(values[0] as Dataset, values[1] as string),
    "data.eraseBatch": (ports, values) => ports.data.eraseBatch(values[0] as Dataset, values[1] as string, values[2] as Date),
    "data.remaining": (ports, values) => ports.data.remaining(values[0] as Dataset, values[1] as string),
    "files.put": (ports, values) => ports.files.put(values[0] as string, values[1] as Parameters<StorePort["put"]>[1]),
    "files.read": (ports, values) => ports.files.read(values[0] as string, values[1] as string),
    "files.signedUrl": (ports, values) => ports.files.signedUrl(values[0] as string, values[1] as number),
    "store.addEvent": (ports, values) => ports.store.addEvent(values[0] as string, values[1] as Date, values[2] as string, values[3] as string | undefined),
    "store.findOpen": (ports, values) => ports.store.findOpen(values[0] as string, values[1] as RequestRecord["type"]),
    "store.get": (ports, values) => ports.store.get(values[0] as string),
    "store.insert": (ports, values) => ports.store.insert(values[0] as RequestRecord),
    "store.listOpen": (ports) => ports.store.listOpen(),
    "store.update": (ports, values) => ports.store.update(values[0] as string, values[1] as Partial<Omit<RequestRecord, "id">>),
    "tombstones.add": (ports, values) => requireTombstones(ports).add(values[0] as string, values[1] as Date),
    "tombstones.keys": (ports) => requireTombstones(ports).keys(),
};

/** Run one port call on the server. `payload` is the JSON array of arguments the workflow sent. */
export const dispatchPort = async (ctx: MutationCtx, method: string, payload: string): Promise<string> => {
    if (!Object.hasOwn(PORT_CALLS, method)) {
        throw new LunoraError("BAD_REQUEST", `Unknown privacy port call "${method}".`);
    }

    const call = PORT_CALLS[method];

    const values = fromWire(JSON.parse(payload)) as ReadonlyArray<unknown>;
    const result = await call(localPorts(ctx), values);

    return JSON.stringify(toWire(result ?? null));
};

/**
 * The ports for a workflow step. Each call is one `ctx.run` into the internal
 * `privacyPort` mutation, so every read and write runs in a database transaction.
 */
export const remotePorts = (run: WorkflowRunContext["run"]): PrivacyPorts => {
    const call = async (method: string, values: ReadonlyArray<unknown>): Promise<unknown> => {
        const text = await run(internal.requests.privacyPort, { method, payload: JSON.stringify(toWire(values)) });

        if (typeof text !== "string") {
            throw new LunoraError("INTERNAL", `privacy port call "${method}" returned no result.`);
        }

        return fromWire(JSON.parse(text));
    };

    const maybe = async <T>(method: string, values: ReadonlyArray<unknown>): Promise<T | undefined> => {
        const value = await call(method, values);

        return value === null ? undefined : (value as T);
    };

    return {
        data: {
            collect: async (dataset, subjectId) => (await call("data.collect", [dataset, subjectId])) as Record<string, Record<string, unknown>[]>,
            eraseBatch: async (dataset, subjectId, now) => (await call("data.eraseBatch", [dataset, subjectId, now])) as { hasMore: boolean },
            remaining: async (dataset, subjectId) => (await call("data.remaining", [dataset, subjectId])) as Record<string, number>,
        },
        files: {
            put: async (requestId, file) => (await call("files.put", [requestId, file])) as string,
            read: async (requestId, name) => maybe<string>("files.read", [requestId, name]),
            signedUrl: async (key, ttlSeconds) => (await call("files.signedUrl", [key, ttlSeconds])) as string,
        },
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
        store: {
            addEvent: async (requestId, at, kind, detail) => {
                await call("store.addEvent", [requestId, at, kind, detail]);
            },
            findOpen: async (subjectId, type) => maybe<RequestRecord>("store.findOpen", [subjectId, type]),
            get: async (id) => maybe<RequestRecord>("store.get", [id]),
            insert: async (record) => {
                await call("store.insert", [record]);
            },
            listOpen: async () => (await call("store.listOpen", [])) as ReadonlyArray<RequestRecord>,
            update: async (id, patch) => {
                await call("store.update", [id, patch]);
            },
        },
        tombstones: {
            add: async (key, erasedAt) => {
                await call("tombstones.add", [key, erasedAt]);
            },
            keys: async () => (await call("tombstones.keys", [])) as ReadonlySet<string>,
        },
    };
};
