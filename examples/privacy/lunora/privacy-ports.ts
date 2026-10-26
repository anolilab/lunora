/**
 * The privacy package's ports, bound to Lunora's database.
 *
 * `localPorts` runs inside a mutation or a query, where `ctx.db` exists. A workflow has no
 * `ctx.db`: its steps reach these same ports through `ctx.run` into the internal
 * `privacyPort` mutation, which hands them to the package's `dispatchPort`
 * (`@lunora/privacy/workflow`). The wire format and the method table are the package's.
 */
import type { ArchivePort, DataPort, Dataset, PrivacyPorts, RequestStore, StorePort } from "@lunora/privacy";
import { ERASE_BATCH, fromRequestRow, isTerminal, OPEN_STATUSES, toRequestPatch, toRequestRow } from "@lunora/privacy";
import { LunoraError } from "lunorash/errors";

import type { Doc as Document_ } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { signFileLink } from "./privacy-files";
import { tombstonesUnreachable } from "./privacy-tombstones";

type RequestRow = Document_<"privacy_requests">;

/** A query can read the ports but not write them; a mutation can do both. */
type LocalContext = MutationCtx | QueryCtx;

/** A dataset this example does not declare. Refused rather than read as empty. */
const unknownDataset = (dataset: Dataset): LunoraError => new LunoraError("INTERNAL", `privacy-example has no reader for dataset "${dataset.id}".`);

/** The sign-in tables live in D1, which only the workflow reaches. A mutation that needs them is refused. */
const signInFromMutation = (): LunoraError =>
    new LunoraError("UNPROCESSABLE", "The sign-in tables are read by the privacy workflow. Run this export or erasure through its workflow.");

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

            return open === undefined ? undefined : fromRequestRow(open);
        },
        get: async (id) => {
            const row = await rowFor(ctx, id);

            return row === undefined ? undefined : fromRequestRow(row);
        },
        insert: async (record) => {
            await writerOf(ctx).insert("privacy_requests", { ...toRequestRow(record) });
        },
        listForSubject: async (subjectId) => {
            const rows = await ctx.db
                .query("privacy_requests")
                .withIndex("bySubject", (q) => q.eq("subjectId", subjectId))
                .collect();

            return rows.map((row) => fromRequestRow(row));
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

            return batches.flat().map((row) => fromRequestRow(row));
        },
        // One mutation is one transaction on the shard, so this read and write cannot interleave with another claim.
        claim: async (id, from, patch) => {
            const row = await rowFor(ctx, id);

            if (row?.status !== from) {
                return false;
            }

            await writerOf(ctx).patch(row._id, toRequestPatch(patch));

            return true;
        },
        update: async (id, patch) => {
            const row = await rowFor(ctx, id);

            if (row !== undefined) {
                await writerOf(ctx).patch(row._id, toRequestPatch(patch));
            }
        },
    };
};

/** The disposition the package hands the app for one row: its verdict under the dataset's retention rules. */
type RowDisposition = Parameters<DataPort["eraseBatch"]>[3];

/** The tasks a subject owns, through the index that leads with the user id. */
const tasksOf = (ctx: LocalContext, subjectId: string) => ctx.db.query("tasks").withIndex("byUser", (q) => q.eq("userId", subjectId));

/** The invoices a subject owns, through the index that leads with the user id. */
const invoicesOf = (ctx: LocalContext, subjectId: string) => ctx.db.query("invoices").withIndex("byUser", (q) => q.eq("userId", subjectId));

/** The tasks: no retention rule, so every row is deleted. Any other verdict fails loudly rather than guessing. */
const tasksPort = (ctx: LocalContext, subjectId: string) => {
    return {
        collect: async () => {
            const rows = await tasksOf(ctx, subjectId).collect();

            return {
                tasks: rows.map((row) => {
                    return { ...row };
                }),
            };
        },
        eraseBatch: async (dataset: Dataset, now: Date, disposition: RowDisposition) => {
            const rows = await tasksOf(ctx, subjectId).take(ERASE_BATCH);
            const database = writerOf(ctx);

            await Promise.all(
                rows.map(async (row) => {
                    if (disposition(dataset, "tasks", { ...row }, now).kind !== "delete") {
                        throw new LunoraError("INTERNAL", "privacy-example has no retention rule for tasks.");
                    }

                    await database.delete(row._id);
                }),
            );

            return { hasMore: rows.length === ERASE_BATCH };
        },
        remaining: async () => {
            const rows = await tasksOf(ctx, subjectId).collect();

            return { tasks: rows.length };
        },
    };
};

/**
 * The invoices. Their `de.voucher` directive keeps each row for its retention period, so erasure
 * moves a kept row into the package's `privacy_archive` and deletes it from `invoices`. The sweep purges it later.
 */
const invoicesPort = (ctx: LocalContext, subjectId: string) => {
    return {
        collect: async () => {
            const rows = await invoicesOf(ctx, subjectId).collect();

            return {
                invoices: rows.map((row) => {
                    return { ...row };
                }),
            };
        },
        eraseBatch: async (dataset: Dataset, now: Date, disposition: RowDisposition) => {
            const rows = await invoicesOf(ctx, subjectId).take(ERASE_BATCH);
            const database = writerOf(ctx);

            await Promise.all(
                rows.map(async (row) => {
                    const verdict = disposition(dataset, "invoices", { ...row }, now);

                    if (verdict.kind === "keep") {
                        await database.insert("privacy_archive", {
                            datasetId: dataset.id,
                            retainUntil: verdict.until.getTime(),
                            row: JSON.stringify(row),
                            subjectId,
                            table: "invoices",
                        });
                    } else if (verdict.kind !== "delete") {
                        throw new LunoraError("INTERNAL", "privacy-example deletes or keeps an invoice; it does not anonymise one.");
                    }

                    await database.delete(row._id);
                }),
            );

            return { hasMore: rows.length === ERASE_BATCH };
        },
        remaining: async () => {
            const rows = await invoicesOf(ctx, subjectId).collect();

            return { invoices: rows.length };
        },
    };
};

/** Routes one dataset to its tables. A dataset this example does not declare is refused. */
const dataPort = (ctx: LocalContext): DataPort => {
    return {
        collect: async (dataset, subjectId) => {
            switch (dataset.id) {
                case "auth":
                case "signInTokens": {
                    throw signInFromMutation();
                }
                case "billing": {
                    return invoicesPort(ctx, subjectId).collect();
                }
                case "tasks": {
                    return tasksPort(ctx, subjectId).collect();
                }
                default: {
                    throw unknownDataset(dataset);
                }
            }
        },
        eraseBatch: async (dataset, subjectId, now, disposition) => {
            switch (dataset.id) {
                case "auth":
                case "signInTokens": {
                    throw signInFromMutation();
                }
                case "billing": {
                    return invoicesPort(ctx, subjectId).eraseBatch(dataset, now, disposition);
                }
                case "tasks": {
                    return tasksPort(ctx, subjectId).eraseBatch(dataset, now, disposition);
                }
                default: {
                    throw unknownDataset(dataset);
                }
            }
        },
        remaining: async (dataset, subjectId) => {
            switch (dataset.id) {
                case "auth":
                case "signInTokens": {
                    throw signInFromMutation();
                }
                case "billing": {
                    return invoicesPort(ctx, subjectId).remaining();
                }
                case "tasks": {
                    return tasksPort(ctx, subjectId).remaining();
                }
                default: {
                    throw unknownDataset(dataset);
                }
            }
        },
    };
};

/** The retention archive: the rows erasure kept, purged once their period has ended. */
const archivePort = (ctx: LocalContext): ArchivePort => {
    return {
        purgeBatch: async (before) => {
            const rows = await ctx.db
                .query("privacy_archive")
                .withIndex("byRetainUntil", (range) => range.lt("retainUntil", before.getTime()))
                .take(ERASE_BATCH);

            const database = writerOf(ctx);

            await Promise.all(rows.map(async (row) => database.delete(row._id)));

            return { hasMore: rows.length === ERASE_BATCH, purged: rows.length };
        },
    };
};

/** The stored file a `${requestId}/${name}` key names, or `null`. */
const fileRowOf = async (ctx: LocalContext, key: string) => {
    const [requestId = "", ...rest] = key.split("/");

    return ctx.db
        .query("exportFiles")
        .withIndex("byRequestAndName", (q) => q.eq("requestId", requestId).eq("name", rest.join("/")))
        .first();
};

/**
 * Export parts and the archive are kept in `exportFiles`. This example has no object
 * storage, so `signedUrl` signs a link the `/privacy/files` route checks; see `privacy-files.ts`.
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
        signedUrl: async (key, ttlSeconds) => signFileLink(key, ttlSeconds, Date.now()),
        delete: async (key) => {
            const row = await fileRowOf(ctx, key);

            if (row !== null) {
                await writerOf(ctx).delete(row._id);
            }
        },
        list: async (prefix) => {
            const requestId = prefix.split("/")[0] ?? "";
            const rows = await ctx.db
                .query("exportFiles")
                .withIndex("byRequestAndName", (q) => q.eq("requestId", requestId))
                .collect();

            return rows.map((row) => `${row.requestId}/${row.name}`).filter((key) => key.startsWith(prefix));
        },
    };
};

/**
 * The ports for one call: a mutation's, or a query's (reads only). The workflow's dispatcher
 * builds them too. The tombstones live outside the shard, so a mutation cannot write them.
 */
export const localPorts = (ctx: LocalContext): PrivacyPorts => {
    return {
        archive: archivePort(ctx),
        data: dataPort(ctx),
        files: filePort(ctx),
        newId: () => crypto.randomUUID(),
        now: () => new Date(),
        store: requestStore(ctx),
        tombstones: tombstonesUnreachable,
    };
};
