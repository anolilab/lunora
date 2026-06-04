/**
 * Test entry-point Worker for `@cirrus/d1` integration tests.
 *
 * The worker exposes the production `D1Client` against a real D1 binding
 * provided by Miniflare. Tests drive the worker's `fetch` handler to
 * exercise the Sessions API (`env.DB.withSession(bookmark)`), prepared
 * statements, and the `MigrationRunner` against a real D1 database.
 */
import type { D1DatabaseLike } from "../../src/d1-client.js";
import { D1Client } from "../../src/d1-client.js";
import { MigrationRunner } from "../../src/migration-runner.js";

interface Env {
    DB: D1Database;
}

const json = (body: unknown, status = 200): Response => Response.json(body, { headers: { "content-type": "application/json" }, status });

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
