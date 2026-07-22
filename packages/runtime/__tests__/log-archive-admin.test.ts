import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import { LunoraError } from "../src/errors";
import type { LogArchiveAdminRouteDeps } from "../src/log-archive-admin-routes";
import { buildLogArchiveAdminRoutes, LOG_ARCHIVE_NOT_CONFIGURED, LOG_ARCHIVE_PATH, resolveLogArchiveFromEnv } from "../src/log-archive-admin-routes";
import type { PipelineLogPage, PipelineLogQuery, PipelineLogReader, PipelineLogReaderOptions } from "../src/pipeline-log-reader";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/** The reader's `query` method, typed so `vi.fn` mock calls stay indexable. */
type ReaderQuery = (query?: PipelineLogQuery) => Promise<PipelineLogPage>;

/** The reader factory, typed loosely on `client` so a fake needs no real `R2SqlClient`. */
type ReaderFactory = (client: unknown, options: PipelineLogReaderOptions) => PipelineLogReader;

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";
const AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };
const CREDS = { R2_SQL_ACCOUNT_ID: "acc", R2_SQL_BUCKET: "logs-bucket", R2_SQL_TOKEN: "tok" };

const PAGE: PipelineLogPage = {
    nextCursor: { ts: 1_700_000_000_000 },
    rows: [{ functionPath: "messages:list", level: "error", message: "boom", ts: 1_700_000_005_000 }],
};

/** A `vi.fn` reader `query` returning {@link PAGE}. */
const stubQuery = (): ReturnType<typeof vi.fn<ReaderQuery>> => vi.fn<ReaderQuery>(async () => PAGE);

/** A minimal deps object: an admin-passthrough `requireAdminOption`, a body echo, and an injected reader. */
const deps = (overrides: Partial<LogArchiveAdminRouteDeps> = {}): LogArchiveAdminRouteDeps => {
    return {
        createReader: () => {
            return { query: stubQuery() };
        },
        logArchive: { table: "logs" },
        readJsonBody: async () => {
            return {};
        },
        requireAdminOption: (_request, value, notConfigured) => {
            if (value === undefined) {
                throw new LunoraError(notConfigured.message, { code: notConfigured.code, status: 400 });
            }

            return value;
        },
        ...overrides,
    };
};

const post = (): Request =>
    new Request(`https://app.example${LOG_ARCHIVE_PATH}`, { body: "{}", headers: { ...AUTH, "content-type": "application/json" }, method: "POST" });

describe("log-archive admin route", () => {
    it("reads a page through the reader, forwarding the parsed query + table config", async () => {
        expect.assertions(4);

        const query = stubQuery();
        const createReader = vi.fn<ReaderFactory>((_client, _options) => {
            return { query };
        });
        const readJsonBody = async (): Promise<Record<string, unknown>> => {
            return { level: "error", limit: 25 };
        };
        const route = buildLogArchiveAdminRoutes(deps({ createReader, logArchive: { namespace: "db", table: "logs" }, readJsonBody }))[LOG_ARCHIVE_PATH]!;

        const response = await route(post(), CREDS);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(PAGE);
        // The table config reaches the reader factory.
        expect(createReader.mock.calls[0]?.[1]).toEqual({ columnMap: undefined, namespace: "db", table: "logs" });
        // The validated query reaches the reader.
        expect(query.mock.calls[0]?.[0]).toEqual({ level: "error", limit: 25 });
    });

    it("passes a keyset cursor through to the reader", async () => {
        expect.assertions(1);

        const query = stubQuery();
        const createReader: ReaderFactory = () => {
            return { query };
        };
        const readJsonBody = async (): Promise<Record<string, unknown>> => {
            return { cursor: { ts: 1_699_999_999_000 } };
        };
        const route = buildLogArchiveAdminRoutes(deps({ createReader, readJsonBody }))[LOG_ARCHIVE_PATH]!;

        await route(post(), CREDS);

        expect(query.mock.calls[0]?.[0]).toEqual({ cursor: { ts: 1_699_999_999_000 } });
    });

    it("rejects an invalid level with BAD_REQUEST before touching the reader", async () => {
        expect.assertions(2);

        const query = stubQuery();
        const createReader: ReaderFactory = () => {
            return { query };
        };
        const readJsonBody = async (): Promise<Record<string, unknown>> => {
            return { level: "nope" };
        };
        const route = buildLogArchiveAdminRoutes(deps({ createReader, readJsonBody }))[LOG_ARCHIVE_PATH]!;

        await expect(route(post(), CREDS)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(query).not.toHaveBeenCalled();
    });

    it("fails closed with LOG_ARCHIVE_NOT_CONFIGURED when credentials are missing", async () => {
        expect.assertions(1);

        const route = buildLogArchiveAdminRoutes(deps())[LOG_ARCHIVE_PATH]!;

        // env carries no R2 SQL creds beyond the account id.
        await expect(route(post(), { R2_SQL_ACCOUNT_ID: "acc" })).rejects.toMatchObject({ code: LOG_ARCHIVE_NOT_CONFIGURED });
    });

    it("honours CLOUDFLARE_ACCOUNT_ID as the account-id fallback", async () => {
        expect.assertions(1);

        const createReader: ReaderFactory = () => {
            return { query: stubQuery() };
        };
        const route = buildLogArchiveAdminRoutes(deps({ createReader }))[LOG_ARCHIVE_PATH]!;

        const response = await route(post(), { CLOUDFLARE_ACCOUNT_ID: "acc", R2_SQL_BUCKET: "b", R2_SQL_TOKEN: "t" });

        expect(response.status).toBe(200);
    });

    it("rejects a non-POST method with 405", async () => {
        expect.assertions(1);

        const route = buildLogArchiveAdminRoutes(deps())[LOG_ARCHIVE_PATH]!;

        await expect(route(new Request(`https://app.example${LOG_ARCHIVE_PATH}`, { headers: AUTH, method: "GET" }), CREDS)).rejects.toMatchObject({
            status: 405,
        });
    });
});

describe("createWorker — log-archive admin endpoint gating", () => {
    it("rejects without a valid admin bearer (403)", async () => {
        expect.assertions(1);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, logArchive: { table: "logs" }, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(`https://app.example${LOG_ARCHIVE_PATH}`, { method: "POST" }), CREDS, fakeContext);

        expect(response.status).toBe(403);
    });

    it("reports LOG_ARCHIVE_NOT_CONFIGURED when no archive table is wired (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(`https://app.example${LOG_ARCHIVE_PATH}`, { headers: AUTH, method: "POST" }), CREDS, fakeContext);

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe(LOG_ARCHIVE_NOT_CONFIGURED);
    });

    it("reports LOG_ARCHIVE_NOT_CONFIGURED when the table is wired but R2 SQL creds are missing (400)", async () => {
        expect.assertions(2);

        const worker = createWorker({ adminToken: ADMIN_TOKEN, logArchive: { table: "logs" }, shardDO: noopNamespace });

        const response = await worker.fetch(new Request(`https://app.example${LOG_ARCHIVE_PATH}`, { headers: AUTH, method: "POST" }), {}, fakeContext);

        expect(response.status).toBe(400);

        const body: { error: { code: string } } = await response.json();

        expect(body.error.code).toBe(LOG_ARCHIVE_NOT_CONFIGURED);
    });
});

describe("resolveLogArchiveFromEnv", () => {
    it("returns undefined when the table env var is unset (the archive stays not-configured)", () => {
        expect.assertions(2);

        expect(resolveLogArchiveFromEnv({})).toBeUndefined();
        expect(resolveLogArchiveFromEnv({ LUNORA_LOG_ARCHIVE_NAMESPACE: "default" })).toBeUndefined();
    });

    it("builds the config from LUNORA_LOG_ARCHIVE_TABLE (+ optional namespace)", () => {
        expect.assertions(2);

        expect(resolveLogArchiveFromEnv({ LUNORA_LOG_ARCHIVE_TABLE: "logs" })).toEqual({ table: "logs" });
        expect(resolveLogArchiveFromEnv({ LUNORA_LOG_ARCHIVE_NAMESPACE: "default", LUNORA_LOG_ARCHIVE_TABLE: "logs" })).toEqual({
            namespace: "default",
            table: "logs",
        });
    });

    it("ignores empty / non-string values and a non-object env", () => {
        expect.assertions(3);

        expect(resolveLogArchiveFromEnv({ LUNORA_LOG_ARCHIVE_TABLE: "" })).toBeUndefined();
        expect(resolveLogArchiveFromEnv({ LUNORA_LOG_ARCHIVE_TABLE: 42 })).toBeUndefined();
        expect(resolveLogArchiveFromEnv(undefined)).toBeUndefined();
    });

    it('drops an empty namespace rather than emitting `namespace: ""`', () => {
        expect.assertions(1);

        expect(resolveLogArchiveFromEnv({ LUNORA_LOG_ARCHIVE_NAMESPACE: "", LUNORA_LOG_ARCHIVE_TABLE: "logs" })).toEqual({ table: "logs" });
    });
});
