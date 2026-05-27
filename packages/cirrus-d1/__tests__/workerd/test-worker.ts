/**
 * Test entry-point Worker for `@cirrus/d1` integration tests.
 *
 * The worker exposes the production `D1Client` against a real D1 binding
 * provided by Miniflare. Tests drive the worker's `fetch` handler to
 * exercise the Sessions API (`env.DB.withSession(bookmark)`), prepared
 * statements, and the `MigrationRunner` against a real D1 database.
 */
import { D1Client } from "../../src/D1Client.js";
import type { D1DatabaseLike } from "../../src/D1Client.js";
import { MigrationRunner } from "../../src/MigrationRunner.js";

export interface Env {
    DB: D1Database;
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/migrate" && request.method === "POST") {
            const body = (await request.json()) as { migrations: { version: number; name: string; sql: string }[] };
            const runner = new MigrationRunner(env.DB as unknown as D1DatabaseLike, body.migrations);
            const result = await runner.run();

            return json(result);
        }

        if (url.pathname === "/insert" && request.method === "POST") {
            const body = (await request.json()) as { id: string; name: string; bookmark?: string };
            const client = new D1Client(env.DB as unknown as D1DatabaseLike);
            const session = client.withSession(body.bookmark);

            await session.run("INSERT INTO users (id, name) VALUES (?, ?)", body.id, body.name);

            return json({ ok: true, bookmark: session.getBookmark() ?? null });
        }

        if (url.pathname === "/list" && request.method === "GET") {
            const bookmark = request.headers.get("x-d1-bookmark") ?? undefined;
            const client = new D1Client(env.DB as unknown as D1DatabaseLike);
            const session = client.withSession(bookmark);
            const result = await session.all<{ id: string; name: string }>("SELECT id, name FROM users ORDER BY id");

            return json({ rows: result.results, bookmark: session.getBookmark() ?? null });
        }

        return new Response("Not found", { status: 404 });
    },
};
