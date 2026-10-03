import { describe, expect, it } from "vitest";

import type { WranglerConfigShape } from "../src/cloudflare/wrangler-to-alchemy";
import { wranglerToAlchemy } from "../src/cloudflare/wrangler-to-alchemy";

const BASE: WranglerConfigShape = { main: "src/server/index.ts", name: "my-app" };

describe("wranglerToAlchemy", () => {
    it("emits an Alchemy 2 stack program for a config with no bindings", () => {
        expect.assertions(5);

        const { source, unsupported } = wranglerToAlchemy(BASE);

        expect(source).toContain(`import { AdoptPolicy, localState, Stack } from "alchemy";`);
        expect(source).toContain(`import * as Cloudflare from "alchemy/Cloudflare";`);
        expect(source).toContain(`    "my-app",\n    { providers: Cloudflare.providers(), state: localState() },`);
        expect(source).toContain(
            `const worker = yield* Cloudflare.Workers.Worker("Worker", {\n            name: "my-app",\n            main: "src/server/index.ts",\n        });`,
        );
        expect(unsupported).toStrictEqual([]);
    });

    it("adopts existing resources rather than creating alongside them", () => {
        expect.assertions(3);

        const { source } = wranglerToAlchemy({
            ...BASE,
            d1_databases: [{ binding: "DB", database_id: "abc123", database_name: "my-app-db" }],
        });

        // Alchemy 2 adopts on `read`, which matches the physical name — so the
        // name must be the one wrangler created, never a generated one.
        expect(source).toContain(`const DB = yield* Cloudflare.D1.Database("DB", { name: "my-app-db" });`);
        // A wrangler-deployed Worker reads as unowned; without the adopt policy
        // the planner fails with OwnedBySomeoneElse instead of taking it over.
        expect(source).toContain(".pipe(AdoptPolicy.adopt(true)),");
        // `database_id` is Cloudflare's handle, not an Alchemy input.
        expect(source).not.toContain("abc123");
    });

    it("declares every provisioned kind by its physical name and binds it on env", () => {
        expect.assertions(6);

        const { source } = wranglerToAlchemy({
            ...BASE,
            kv_namespaces: [{ binding: "CACHE", id: "kv-id" }],
            queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
            r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
            vectorize: [{ binding: "SEARCH", index_name: "posts" }],
        });

        expect(source).toContain(`Cloudflare.R2.Bucket("FILES", { name: "files" })`);
        expect(source).toContain(`Cloudflare.Queues.Queue("JOBS", { name: "jobs" })`);
        // eslint-disable-next-line no-secrets/no-secrets -- emitted Alchemy source, not a credential
        expect(source).toContain(`Cloudflare.Vectorize.Index("SEARCH", { name: "posts" })`);
        // KV adopts by title and wrangler has only the id — the emitted source says so.
        expect(source).toContain(`Cloudflare.KV.Namespace("CACHE", { title: "CACHE" })`);
        expect(source).toMatch(/Adopted by title/u);
        expect(source).toContain("                FILES,\n");
    });

    it("binds the binding-only kinds as env descriptors", () => {
        expect.assertions(4);

        const { source } = wranglerToAlchemy({
            ...BASE,
            ai: { binding: "AI" },
            analytics_engine_datasets: [{ binding: "EVENTS", dataset: "events" }],
            browser: { binding: "BROWSER" },
            images: { binding: "IMAGES" },
        });

        expect(source).toContain(`AI: Cloudflare.Workers.AI("AI"),`);
        expect(source).toContain(`BROWSER: Cloudflare.Workers.Browser("BROWSER"),`);
        expect(source).toContain(`IMAGES: Cloudflare.Images.Images("IMAGES"),`);
        // eslint-disable-next-line no-secrets/no-secrets -- emitted Alchemy source, not a credential
        expect(source).toContain(`EVENTS: Cloudflare.AnalyticsEngine.Dataset("EVENTS", { dataset: "events" }),`);
    });

    it("binds Durable Objects and flags a KV-backed class, since Alchemy 2 creates new classes on SQLite", () => {
        expect.assertions(4);

        const { source, unsupported } = wranglerToAlchemy({
            ...BASE,
            durable_objects: {
                bindings: [
                    { class_name: "ShardDO", name: "SHARD" },
                    { class_name: "PlainDO", name: "PLAIN" },
                    { class_name: "OtherDO", name: "OTHER", script_name: "other-worker" },
                ],
            },
            migrations: [{ new_sqlite_classes: ["ShardDO"] }, { new_classes: ["PlainDO"] }],
        });

        // eslint-disable-next-line no-secrets/no-secrets -- emitted Alchemy source, not a credential
        expect(source).toContain(`SHARD: Cloudflare.Workers.DurableObject("SHARD", { className: "ShardDO" }),`);
        expect(source).toMatch(/PlainDO is KV-backed/u);
        // eslint-disable-next-line no-secrets/no-secrets -- emitted Alchemy source, not a credential
        expect(source).toContain(`OTHER: Cloudflare.Workers.DurableObject("OTHER", { className: "OtherDO", scriptName: "other-worker" }),`);
        expect(unsupported).toStrictEqual([]);
    });

    it("attaches queue consumers to the worker, declaring a consumed queue nothing produces to", () => {
        expect.assertions(3);

        const { source } = wranglerToAlchemy({
            ...BASE,
            queues: {
                consumers: [{ dead_letter_queue: "dlq", max_batch_size: 5, max_batch_timeout: 2, queue: "jobs" }, { queue: "inbound" }],
                producers: [{ binding: "JOBS", queue: "jobs" }],
            },
        });

        // Wrangler's batch timeout is seconds; Alchemy's is milliseconds.
        expect(source).toContain(
            `yield* Cloudflare.Queues.Consumer("jobs-consumer", { queueId: JOBS.queueId, scriptName: worker.workerName, deadLetterQueue: "dlq", settings: { batchSize: 5, maxWaitTimeMs: 2000 } });`,
        );
        expect(source).toContain(`const queue_inbound = yield* Cloudflare.Queues.Queue("inbound", { name: "inbound" });`);
        expect(source).toContain(`Cloudflare.Queues.Consumer("inbound-consumer", { queueId: queue_inbound.queueId, scriptName: worker.workerName });`);
    });

    it("reports a pull consumer rather than attaching the worker to it", () => {
        expect.assertions(2);

        const { source, unsupported } = wranglerToAlchemy({ ...BASE, queues: { consumers: [{ queue: "pulled", type: "http_pull" }] } });

        expect(unsupported).toStrictEqual([`queues.consumers "pulled" (http_pull)`]);
        expect(source).not.toContain("Consumer(");
    });

    it("carries workflows, assets, crons, compatibility, tail consumers and workers_dev onto the worker", () => {
        expect.assertions(6);

        const { source } = wranglerToAlchemy({
            ...BASE,
            assets: { binding: "ASSETS", directory: "./dist/client", not_found_handling: "single-page-application" },
            compatibility_date: "2026-04-07",
            compatibility_flags: ["nodejs_compat"],
            tail_consumers: [{ service: "logs-worker" }],
            triggers: { crons: ["0 * * * *"] },
            workers_dev: false,
            workflows: [{ binding: "FLOW", class_name: "MyFlow", name: "my-flow" }],
        });

        expect(source).toContain(`assets: { directory: "./dist/client", notFoundHandling: "single-page-application" },`);
        expect(source).toContain(`compatibility: { date: "2026-04-07", flags: ["nodejs_compat"] },`);
        expect(source).toContain(`crons: ["0 * * * *"],`);
        expect(source).toContain(`tailConsumers: ["logs-worker"],`);
        expect(source).toContain("workersDev: false,");
        expect(source).toContain(`FLOW: Cloudflare.Workflows.Workflow("MyFlow", { className: "MyFlow" }),`);
    });

    it("reports every section it cannot carry over instead of dropping it silently", () => {
        expect.assertions(2);

        const { source, unsupported } = wranglerToAlchemy({
            ...BASE,
            ai_search: [{ binding: "BLOG_SEARCH", instance_name: "blog" }],
            ai_search_namespaces: [{ binding: "AI_SEARCH", namespace: "default" }],
            assets: { binding: "STATIC", directory: "./public" },
            flagship: [{ app_id: "app-abc", binding: "FLAGS" }],
            hyperdrive: [{ binding: "PG", id: "hd-1" }],
            secrets_store_secrets: [{ binding: "WALLET_KEY", secret_name: "wallet", store_id: "store-1" }],
            send_email: [{ name: "MAILER" }],
            services: [{ binding: "AUTH", service: "auth-worker" }],
            worker_loaders: [{ binding: "LOADER" }],
        } as WranglerConfigShape);

        expect(unsupported.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "ai_search",
            "ai_search_namespaces",
            `assets.binding "STATIC" (Alchemy 2 always binds assets as ASSETS)`,
            "flagship",
            "hyperdrive (Alchemy creates a Hyperdrive config from origin credentials wrangler.jsonc does not carry)",
            "secrets_store_secrets",
            "send_email",
            "services",
            "worker_loaders",
        ]);
        expect(source).not.toContain("AUTH");
    });

    it("preserves a var's JSON type instead of stringifying it", () => {
        expect.assertions(3);

        // Alchemy binds a non-string literal as `json`, so a numeric var stays a number.
        const { source } = wranglerToAlchemy({ ...BASE, vars: { DEBUG: false, LIMITS: { soft: 1 }, MAX: 5 } });

        expect(source).toContain("MAX: 5,");
        expect(source).toContain("DEBUG: false,");
        expect(source).toContain(`LIMITS: {"soft":1},`);
    });

    it("quotes a binding name that is not a valid identifier", () => {
        expect.assertions(2);

        const { source } = wranglerToAlchemy({ ...BASE, r2_buckets: [{ binding: "my-bucket", bucket_name: "b" }] });

        expect(source).toContain(`"my-bucket": binding_my_bucket,`);
        expect(source).toContain("const binding_my_bucket =");
    });

    it("omits an empty env block rather than emitting an empty object", () => {
        expect.assertions(1);

        expect(wranglerToAlchemy(BASE).source).not.toContain("env:");
    });

    it("emits each var binding exactly once", () => {
        expect.assertions(1);

        const { source } = wranglerToAlchemy({ ...BASE, vars: { PUBLIC_URL: "https://example.com", SECRET_KEY: "s3cr3t" } });

        expect([(source.match(/PUBLIC_URL:/gu) ?? []).length, (source.match(/SECRET_KEY:/gu) ?? []).length]).toStrictEqual([1, 1]);
    });
});
