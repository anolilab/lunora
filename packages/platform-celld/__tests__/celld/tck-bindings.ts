/**
 * The binding-backed half of the celld ratings, checked on a live celld.
 *
 * The contract suites cover what `ShardHost` / `SocketHost` / `ShardKvStore`
 * rest on. The other `native` ratings — D1, KV, R2, Queues, Workflows, Cron
 * Triggers — rest on celld bindings (and Discord channel verification on its
 * Web Crypto, `sqliteVectorStore`'s vec0 index on its `sqlite_vec` flag, and
 * `jsCodeTool` on its Dynamic Workers), so each check here drives the binding
 * through Lunora's own adapter where there is one (`D1Client`, `createKv`,
 * `createStorage`, `createQueues` + `dispatchQueueBatch`), in the call shapes
 * the runtime actually uses (see each check). Checks that complete
 * asynchronously (a queue delivery, a workflow run, a cron tick) record what
 * they observed in KV under `tck:*`, and the node side polls for it.
 */
import type { AgentToolContext } from "@lunora/agent";
import { jsCodeTool } from "@lunora/agent";
import { verifyDiscord } from "@lunora/agent/channels";
import { sqliteVectorStore } from "@lunora/ai/rag";
import { createKv } from "@lunora/bindings/kv";
import { D1Client } from "@lunora/d1";
import type { D1DatabaseLike, KVNamespaceLike, QueueBindingLike, R2BucketLike } from "@lunora/platform";
import type { QueueDefinition } from "@lunora/queue";
import { createQueues, defineQueue, dispatchQueueBatch } from "@lunora/queue";
import { createStorage } from "@lunora/storage";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";

/**
 * The bindings the TCK worker declares for these checks (see wrangler.jsonc),
 * typed as Lunora's structural projections — the shapes its adapters accept,
 * and so the only surface this file may lean on.
 */
type BindingEnv = {
    DB: D1DatabaseLike;
    JOBS: QueueBindingLike;
    KV: KVNamespaceLike;
    LOADER: unknown;
    R2: R2BucketLike;
    TCK_FLOW: Workflow;
    VECTORS: DurableObjectNamespace;
};

const QUEUE_NAME = "tck-jobs";

const check = (condition: boolean, message: string): void => {
    if (!condition) {
        throw new Error(message);
    }
};

const same = (actual: unknown, expected: unknown, what: string): void => {
    check(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/**
 * `.global()` tables: the generated exec wraps `withSession` / `getBookmark`,
 * reads through `prepare().bind().all()` (including `UPDATE … RETURNING`),
 * writes through `run()` and `batch()`, meters `meta.rows_*`, and the search
 * layout creates fts5 tables. No `exec()`, no multi-statement `prepare()`, no
 * application transaction — all of which celld refuses.
 */
const checkD1 = async (env: BindingEnv): Promise<void> => {
    const client = new D1Client(env.DB);
    const session = client.withSession();

    await session.run("CREATE TABLE IF NOT EXISTS tck_rows (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    await session.run("DELETE FROM tck_rows");
    check(client.raw.batch !== undefined, "D1 exposes batch()");
    await client.raw.batch?.([
        client.raw.prepare("INSERT INTO tck_rows (id, n) VALUES (?, ?)").bind("a", 1),
        client.raw.prepare("INSERT INTO tck_rows (id, n) VALUES (?, ?)").bind("b", 2),
    ]);

    const { meta, results } = await session.all<{ id: string; n: number }>("SELECT id, n FROM tck_rows ORDER BY id");

    same(
        results,
        [
            { id: "a", n: 1 },
            { id: "b", n: 2 },
        ],
        "rows after batch",
    );
    check(typeof meta?.["rows_read"] === "number", "meta.rows_read is metered");

    const returned = await session.all<{ n: number }>("UPDATE tck_rows SET n = n + 10 WHERE id = ? RETURNING n", "a");

    same(returned.results, [{ n: 11 }], "UPDATE … RETURNING");
    same(await session.first<{ n: number }>("SELECT n FROM tck_rows WHERE id = ?", "b"), { n: 2 }, "first()");
    check(typeof session.getBookmark() === "string", "getBookmark() returns a token after a query");

    await session.run("CREATE VIRTUAL TABLE IF NOT EXISTS tck_search USING fts5(body)");
    await session.run("DELETE FROM tck_search");
    await session.run("INSERT INTO tck_search (body) VALUES (?)", "celld serves lunora");

    const matched = await session.all("SELECT body FROM tck_search WHERE tck_search MATCH ?", "lunora");

    same(matched.results, [{ body: "celld serves lunora" }], "fts5 match");
};

/** `ctx.kv`: `createKv` over the namespace — JSON values, metadata, TTL, prefix listing. */
const checkKv = async (env: BindingEnv): Promise<void> => {
    const kv = createKv({ keyPrefix: "check", namespace: env.KV });

    await kv.put("doc", { hello: "celld" }, { expirationTtl: 3600, metadata: { owner: "tck" } });

    same(await kv.get("doc"), { hello: "celld" }, "get()");

    const { metadata, value } = await kv.getWithMetadata("doc");

    same([value, metadata], [{ hello: "celld" }, { owner: "tck" }], "getWithMetadata()");

    const listed = await kv.list();

    same(
        listed.keys.map((key) => key.name),
        ["doc"],
        "list() under the prefix",
    );

    await kv.delete("doc");

    same(await kv.get("doc"), null, "get() after delete()");
};

/**
 * `ctx.storage` over R2, plus the raw calls the CDC archive and scheduled
 * backups make: `put` with `sha256`, `list` with `startAfter` / `delimiter`.
 */
const checkR2 = async (env: BindingEnv): Promise<void> => {
    const storage = createStorage({ bucket: env.R2, bucketName: "tck" });

    await storage.upload("docs/a.txt", "alpha", { contentType: "text/plain", customMetadata: { owner: "tck" } });
    await storage.upload("docs/b.txt", "bravo", { contentType: "text/plain" });

    const body = await storage.download("docs/a.txt");

    same(await body?.text(), "alpha", "download()");
    const stored = await storage.getMetadata("docs/a.txt");

    same(stored?.customMetadata, { owner: "tck" }, "customMetadata");

    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("segment")))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");

    await env.R2.put("cdc/0002", "segment", { httpMetadata: { contentType: "application/json" }, sha256 });
    await env.R2.put("cdc/0001", "segment", { sha256 });

    const afterFirst = await env.R2.list({ prefix: "cdc/", startAfter: "cdc/0001" });
    const folded = await env.R2.list({ delimiter: "/", prefix: "" });

    same(
        afterFirst.objects.map((object) => object.key),
        ["cdc/0002"],
        "list({ startAfter })",
    );
    same(
        (folded.delimitedPrefixes ?? []).toSorted((a, b) => a.localeCompare(b)),
        ["cdc/", "docs/"],
        "list({ delimiter })",
    );

    for (const key of ["docs/a.txt", "docs/b.txt"]) {
        // eslint-disable-next-line no-await-in-loop -- two deletes, order irrelevant
        await storage.delete(key);
    }

    await env.R2.delete("cdc/0001");
    await env.R2.delete("cdc/0002");

    same(await storage.head("docs/a.txt"), null, "head() after delete()");
};

/**
 * The push consumer, as `lunora` wires it: `dispatchQueueBatch` over a
 * `defineQueue` handler. The first delivery of each message throws, so the
 * check sees Lunora's retry-on-throw become a real redelivery with
 * `attempts === 2`.
 */
const tckJobs: QueueDefinition<{ id: string }> = defineQueue<{ id: string }>({
    handler: async (context, batch) => {
        const kv = context.env["KV"] as KVNamespaceLike;

        for (const message of batch.messages) {
            if (message.attempts === 1) {
                throw new Error("first delivery fails on purpose");
            }

            // eslint-disable-next-line no-await-in-loop -- one record per message
            await kv.put(`tck:queue:${message.body.id}`, JSON.stringify({ attempts: message.attempts, id: message.id }));
        }
    },
    name: QUEUE_NAME,
});

const startQueue = async (env: BindingEnv, id: string): Promise<void> => {
    const queues = createQueues({ bindings: { tckJobs: env.JOBS } });

    await queues["tckJobs"]?.send({ id }, { contentType: "json" });
};

const consumeQueue = async (batch: MessageBatch, env: BindingEnv): Promise<void> => {
    await dispatchQueueBatch(batch, { [QUEUE_NAME]: { definition: tckJobs, exportName: "tckJobs" } }, { env });
};

/**
 * The step APIs `@lunora/workflow` calls: `step.do` (with a retry config, and
 * with the rollback option `defineStep({ rollback })` forwards, which celld
 * lists as unavailable), and `step.waitForEvent` answered by `sendEvent`.
 */
class TckWorkflow extends WorkflowEntrypoint<BindingEnv, { seed: number }> {
    // eslint-disable-next-line class-methods-use-this -- `run` is the WorkflowEntrypoint contract; the runtime calls it on an instance
    public override async run(event: WorkflowEvent<{ seed: number }>, step: WorkflowStep): Promise<unknown> {
        const doubled = await step.do("double", { retries: { delay: 10, limit: 1 } }, async () => event.payload.seed * 2);
        const rollback = await step.do("probe rollback", async () => {
            try {
                await (step.do as (...args: unknown[]) => Promise<unknown>)(
                    "with rollback",
                    async () => "ran",
                    async () => {},
                );

                return "accepted";
            } catch (error) {
                return `refused: ${error instanceof Error ? error.message : String(error)}`;
            }
        });
        const approval = await step.waitForEvent<{ ok: boolean }>("approval", { timeout: "1 minute", type: "approve" });

        return { approved: approval.payload.ok, doubled, rollback };
    }
}

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Discord channel verification (`verifyDiscord`): Ed25519 over `timestamp +
 * body`, the public key imported in `raw` form. celld gained Ed25519 in v0.6.0;
 * before that the import threw and every Discord interaction was rejected.
 */
const checkEd25519 = async (): Promise<void> => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = toHex(await crypto.subtle.exportKey("raw", pair.publicKey));
    const body = JSON.stringify({ type: 1 });
    const timestamp = "1790000000";
    const signature = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(timestamp + body)));

    check(await verifyDiscord({ body, publicKey, signature, timestamp }), "a valid Discord signature verifies");
    check(!(await verifyDiscord({ body: `${body} `, publicKey, signature, timestamp })), "a tampered body is rejected");
};

/**
 * `sqliteVectorStore({ ann })` over a cell's own `storage.sql`: celld loads
 * sqlite-vec into a Durable Object's SQLite when the worker sets the
 * `sqlite_vec` flag (see wrangler.jsonc), and nowhere else — hence a cell.
 */
class VectorCell {
    public constructor(private readonly state: DurableObjectState) {}

    public async fetch(): Promise<Response> {
        const { sql } = this.state.storage;
        const store = sqliteVectorStore({
            ann: { dimensions: 3 },
            exec: (statement, parameters) => sql.exec(statement, ...parameters).toArray(),
        });
        const vector = (values: number[]) => async (): Promise<number[]> => values;

        try {
            await store.upsert({ embed: vector([1, 0, 0]), id: "x", input: "x", metadata: { kind: "a" } });
            await store.upsert({ embed: vector([0, 1, 0]), id: "y", input: "y" });
            await store.upsert({ embed: vector([0.7, 0.7, 0]), id: "z", input: "z" });
            await store.deleteByIds(["y"]);

            const nearest = await store.query({ embed: vector([0.9, 0.1, 0]), input: "q", topK: 3 });

            same(
                nearest.matches.map((match) => match.id),
                ["x", "z"],
                "KNN through the vec0 index",
            );
            same(nearest.matches[0]?.metadata, { kind: "a" }, "metadata read back from the table");

            return new Response("ok");
        } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
        }
    }
}

const checkVectorIndex = async (env: BindingEnv): Promise<void> => {
    const response = await env.VECTORS.get(env.VECTORS.newUniqueId()).fetch("https://cell/");

    check(response.ok, await response.text());
};

/**
 * `jsCodeTool` through the worker's `LOADER` binding (celld's Dynamic Workers):
 * a script's value and `console` output come back, `globalOutbound: null`
 * leaves it no network, and the CPU budget stops a busy loop.
 */
const checkWorkerLoader = async (env: BindingEnv): Promise<void> => {
    const tool = jsCodeTool({ cpuMs: 50 });
    const run = async (code: string) => tool.execute({ code }, { env } as unknown as AgentToolContext);

    same(await run('console.log("hi", 2);\nreturn [1, 2].map((n) => n * 21);'), { logs: ["hi 2"], value: [21, 42] }, "script result");

    const offline = await run('await fetch("https://example.com/");\nreturn "reached the network";');

    check(offline.value === undefined && typeof offline.error === "string", `fetch is refused: ${JSON.stringify(offline)}`);

    const busy = await run("for (;;) {}");

    check(typeof busy.error === "string", `a busy loop is stopped: ${JSON.stringify(busy)}`);
};

/** What `scheduled()` hands `runCronJobs` and the backup cron: `cron` and `scheduledTime`. */
const recordCron = async (controller: ScheduledController, env: BindingEnv): Promise<void> => {
    await env.KV.put("tck:cron", JSON.stringify({ cron: controller.cron, scheduledTime: controller.scheduledTime }));
};

type BindingResult = { message?: string; status: "failed" | "passed" | "pending"; value?: unknown };

/**
 * `GET /binding/<name>` for the synchronous checks, and the start/poll pairs
 * for the asynchronous ones.
 */
const handleBindingRoute = async (request: Request, env: BindingEnv): Promise<BindingResult> => {
    const url = new URL(request.url);
    const name = url.pathname.slice("/binding/".length);
    const id = url.searchParams.get("id") ?? "";
    const synchronous: Record<string, (env: BindingEnv) => Promise<void>> = {
        d1: checkD1,
        ed25519: checkEd25519,
        kv: checkKv,
        loader: checkWorkerLoader,
        r2: checkR2,
        vec: checkVectorIndex,
    };

    try {
        const run = synchronous[name];

        if (run !== undefined) {
            await run(env);

            return { status: "passed" };
        }

        switch (name) {
            case "cron/status": {
                const recorded = await env.KV.get("tck:cron", "json");

                return recorded === null ? { status: "pending" } : { status: "passed", value: recorded };
            }
            case "queue/start": {
                await startQueue(env, id);

                return { status: "passed" };
            }
            case "queue/status": {
                const recorded = await env.KV.get(`tck:queue:${id}`, "json");

                return recorded === null ? { status: "pending" } : { status: "passed", value: recorded };
            }
            case "workflow/event": {
                const instance = await env.TCK_FLOW.get(id);

                await instance.sendEvent({ payload: { ok: true }, type: "approve" });

                return { status: "passed" };
            }
            case "workflow/start": {
                const instance = await env.TCK_FLOW.create({ id, params: { seed: 21 } });

                return { status: "passed", value: instance.id };
            }
            case "workflow/status": {
                const instance = await env.TCK_FLOW.get(id);

                return { status: "passed", value: await instance.status() };
            }
            default: {
                return { message: `no binding check "${name}"`, status: "failed" };
            }
        }
    } catch (error) {
        return { message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error), status: "failed" };
    }
};

export type { BindingEnv, BindingResult };
export { consumeQueue, handleBindingRoute, recordCron, TckWorkflow, VectorCell };
