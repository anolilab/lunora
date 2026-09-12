/**
 * Test entry-point Worker for `@lunora/d1` integration tests.
 *
 * The worker exposes the production `D1Client` against a real D1 binding
 * provided by Miniflare. Tests drive the worker's `fetch` handler to
 * exercise the Sessions API (`env.DB.withSession(bookmark)`), prepared
 * statements, and the `MigrationRunner` against a real D1 database.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";

import type { D1DatabaseLike } from "../../src/d1-client";
import { D1Client } from "../../src/d1-client";
import type { D1Exec } from "../../src/d1-ctx-db";
import { createD1CtxDb } from "../../src/d1-ctx-db";
import { MigrationRunner } from "../../src/migration-runner";

interface Env {
    DB: D1Database;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { headers: { "content-type": "application/json" }, status });

/** Minimal `D1Exec` over a real D1 binding — the ctx-db needs only `all` and `run`. */
const d1CtxExec = (database: D1Database): D1Exec => {
    return {
        all: async (query, parameters) => {
            const result = await database
                .prepare(query)
                .bind(...parameters)
                .all();

            return result.results;
        },
        run: async (query, parameters) => {
            await database
                .prepare(query)
                .bind(...parameters)
                .run();
        },
    };
};

const col = (kind: string, meta: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true }, ...meta }, kind };
};

/** The `.global()` table `/value-encoding` provisions and round-trips. */
const valueEncodingSchema: SchemaLike = {
    tables: {
        enc: {
            indexes: [],
            shape: {
                litBigint: col("literal", { value: 7n }),
                litBoolean: col("literal", { value: true }),
                litNumber: col("literal", { value: 1 }),
                litString: col("literal", { value: "x" }),
                optAny: col("optional", { inner: col("any") }),
                optString: col("optional", { inner: col("string") }),
                untyped: col("any"),
            },
            shardMode: { kind: "global" },
        },
    },
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/migrate" && request.method === "POST") {
            const body = await request.json<{ migrations: { name: string; sql: string; version: number }[] }>();
            const runner = new MigrationRunner(env.DB as unknown as D1DatabaseLike, body.migrations);
            const result = await runner.run();

            return json(result);
        }

        if (url.pathname === "/insert" && request.method === "POST") {
            const body = await request.json<{ bookmark?: string; id: string; name: string }>();
            const client = new D1Client(env.DB as unknown as D1DatabaseLike);
            const session = client.withSession(body.bookmark);

            await session.run("INSERT INTO users (id, name) VALUES (?, ?)", body.id, body.name);

            return json({ bookmark: session.getBookmark() ?? null, ok: true });
        }

        // Round-trip the three column shapes whose storage form the node:sqlite
        // harness cannot settle on its own: what a value becomes on the way into
        // a column is decided by that column's AFFINITY, and only the engine D1
        // actually runs can prove which affinity was provisioned and what it did
        // to the bound value.
        if (url.pathname === "/value-encoding" && request.method === "POST") {
            const db = createD1CtxDb({ exec: d1CtxExec(env.DB), idGenerator: () => crypto.randomUUID(), schema: valueEncodingSchema });
            const id = await db.insert("enc", {
                litBigint: 7n,
                litBoolean: true,
                litNumber: 1,
                litString: "x",

                optAny: null,
                untyped: "$lunora.wire$42",
            });
            const read = (await db.get(id)) ?? {};
            const columns = await env.DB.prepare(`SELECT name, type FROM pragma_table_info('enc')`).all<{ name: string; type: string }>();

            return json({
                columnTypes: Object.fromEntries(columns.results.map((column) => [column.name, column.type])),
                document: {
                    // `bigint` has no JSON form; the tag is what the assertion reads.
                    litBigint: typeof read["litBigint"] === "bigint" ? `${read["litBigint"].toString()}n` : read["litBigint"],
                    litBoolean: read["litBoolean"],
                    litNumber: read["litNumber"],
                    litString: read["litString"],
                    optAny: read["optAny"],
                    optAnyPresent: "optAny" in read,
                    optStringPresent: "optString" in read,
                    untyped: read["untyped"],
                },
            });
        }

        if (url.pathname === "/list" && request.method === "GET") {
            const bookmark = request.headers.get("x-d1-bookmark") ?? undefined;
            const client = new D1Client(env.DB as unknown as D1DatabaseLike);
            const session = client.withSession(bookmark);
            const result = await session.all<{ id: string; name: string }>("SELECT id, name FROM users ORDER BY id");

            return json({ bookmark: session.getBookmark() ?? null, rows: result.results });
        }

        return new Response("Not found", { status: 404 });
    },
};

export type { Env };
