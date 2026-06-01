import { bench, describe } from "vitest";

import type { HttpActionCtx } from "../src/index.js";
import { httpAction, httpRoute, httpRouter, v } from "../src/index.js";

/**
 * The hono migration (§2.2) replaced the hand-rolled router with hono's
 * trie + middleware chain. The bench measures dispatch cost end-to-end —
 * `app.fetch(request, env)` → middleware → handler → Response — for the
 * three surfaces shipped:
 *
 * - **httpAction** — the raw `(ctx, request) => Response` adapter. The cheapest
 * path; only the cirrus-ctx middleware runs.
 * - **httpRoute (plain)** — typed route w/ no
 * `.searchParams()/.body()/.params()/.output()`. Adds the builder-compiled
 * handler over the raw one.
 * - **httpRoute + searchParams** — adds the query-string parse + validate.
 * - **httpRoute + body** — POST handler that parses + validates JSON body.
 * - **httpRoute + output** — adds the output-schema validate on return.
 *
 * Subtract each variant from the plain `httpRoute` to see the per-step
 * cost of the typed builder pieces.
 */

const ctx = {} as HttpActionCtx;
const ctxEnv = { __cirrusCtx: ctx };

// httpAction — raw adapter.
const rawApp = httpRouter();

rawApp.get(
    "/raw",
    httpAction(() => new Response("ok")),
);

// httpRoute — plain (no validators, no output).
const plainRoute = httpRoute.get("/plain").handler(() => {
    return { ok: true };
});
const plainApp = httpRouter();

plainApp.get("/plain", plainRoute);

// httpRoute + searchParams.
const searchRoute = httpRoute
    .get("/search")
    .searchParams({ active: v.boolean(), limit: v.number() })
    .handler(({ searchParams }) => {
        return { ok: true, params: searchParams };
    });
const searchApp = httpRouter();

searchApp.get("/search", searchRoute);

// httpRoute + body.
const bodyRoute = httpRoute
    .post("/body")
    .body({ text: v.string() })
    .handler(({ body }) => {
        return { echo: body.text };
    });
const bodyApp = httpRouter();

bodyApp.post("/body", bodyRoute);

// httpRoute + output.
const outputRoute = httpRoute
    .get("/output")
    .output(v.object({ ok: v.boolean() }))
    .handler(() => {
        return { ok: true };
    });
const outputApp = httpRouter();

outputApp.get("/output", outputRoute);

describe("hono dispatch — httpAction vs httpRoute (no validators) vs validators", () => {
    bench("httpAction (raw adapter)", async () => {
        await rawApp.fetch(new Request("https://x/raw"), ctxEnv);
    });

    bench("httpRoute plain (no validators)", async () => {
        await plainApp.fetch(new Request("https://x/plain"), ctxEnv);
    });

    bench("httpRoute + searchParams (?limit=5&active=true)", async () => {
        await searchApp.fetch(new Request("https://x/search?limit=5&active=true"), ctxEnv);
    });

    bench("httpRoute + body (POST JSON {text})", async () => {
        await bodyApp.fetch(new Request("https://x/body", { body: JSON.stringify({ text: "hi" }), method: "POST" }), ctxEnv);
    });

    bench("httpRoute + output (parse + validate return)", async () => {
        await outputApp.fetch(new Request("https://x/output"), ctxEnv);
    });
});
