import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import { wranglerCodegenInputs } from "@lunora/config/cloudflare";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../../src/cli";
import type { StreamingFetchLike } from "../../src/commands/data-transfer/shared";
import { runPreviewCommand } from "../../src/commands/preview/handler";
import type { PreviewConfig, PreviewPlan } from "../../src/commands/preview/plan";
import { planPreview, previewEnvironmentBlock, previewNames, productionCollisions, resourceKey } from "../../src/commands/preview/plan";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import type { Spawner } from "../../src/util/spawn";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

/** Every production identity below; none may reach a preview's env block. */
const PRODUCTION_IDENTITIES = [
    "lunora-app",
    "lunora-app-staging",
    "app.example.com",
    "prod-db",
    "prod-d1-uuid",
    "prod-d1-dev-uuid",
    "prod-kv-id",
    "prod-kv-dev-id",
    "prod-files",
    "prod-files-dev",
    "staging-db",
    "staging-d1-uuid",
];

const PRODUCTION_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "routes": [{ "pattern": "app.example.com", "custom_domain": true }],
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "vars": { "PUBLIC_FLAG": "on" },
    "d1_databases": [{ "binding": "DB", "database_name": "prod-db", "database_id": "prod-d1-uuid", "preview_database_id": "prod-d1-dev-uuid" }],
    "kv_namespaces": [{ "binding": "CACHE", "id": "prod-kv-id", "preview_id": "prod-kv-dev-id" }],
    "r2_buckets": [{ "binding": "FILES", "bucket_name": "prod-files", "preview_bucket_name": "prod-files-dev" }],
    "env": {
        "staging": {
            "name": "lunora-app-staging",
            "d1_databases": [{ "binding": "DB", "database_name": "staging-db", "database_id": "staging-d1-uuid" }]
        }
    }
}
`;

const silentLogger = (): { errors: string[]; infos: string[]; logger: Logger; warns: string[] } => {
    const errors: string[] = [];
    const infos: string[] = [];
    const warns: string[] = [];

    return {
        errors,
        infos,
        logger: {
            error: (message) => errors.push(message),
            info: (message) => infos.push(message),
            success: (message) => infos.push(message),
            warn: (message) => warns.push(message),
        },
        warns,
    };
};

const json = (body: unknown, status = 200): Response => Response.json(body, { headers: { "Content-Type": "application/json" }, status });

const envelope = (result: unknown): Response => json({ errors: [], result, result_info: { total_pages: 1 }, success: true });

const notFound = (): Response => json({ errors: [{ code: 10_000, message: "not found" }], success: false }, 404);

const KV_VALUE_PATH = /^\/storage\/kv\/namespaces\/([^/]+)\/values\/(.+)$/u;
const KV_KEYS_PATH = /^\/storage\/kv\/namespaces\/([^/]+)\/keys$/u;
const KV_NAMESPACE_PATH = /^\/storage\/kv\/namespaces\/([^/]+)$/u;
const D1_PATH = /^\/d1\/database\/([^/]+)$/u;
const R2_PATH = /^\/r2\/buckets\/([^/]+)$/u;
const R2_OBJECTS_PATH = /^\/r2\/buckets\/([^/]+)\/objects$/u;
const R2_OBJECT_PATH = /^\/r2\/buckets\/([^/]+)\/objects\/(.+)$/u;
const SCRIPT_SETTINGS_PATH = /^\/workers\/scripts\/([^/]+)\/settings$/u;
const SCRIPT_PATH = /^\/workers\/scripts\/([^/]+)$/u;
const ACCOUNT_PREFIX = /^\/client\/v4\/accounts\/[^/]+/u;

/**
 * An in-memory Cloudflare account answering the REST calls a preview makes. `keysPageSize` pages the KV keys
 * listing by cursor; `hiddenKvListings` makes that many namespace listings come back empty, as a racing
 * deploy that has not yet seen another's create would.
 */
const fakeAccount = (
    options: { hiddenKvListings?: number; keysPageSize?: number } = {},
): {
    calls: { method: string; path: string }[];
    d1: Map<string, string>;
    fetch: typeof globalThis.fetch;
    kv: Map<string, string>;
    kvValues: Map<string, Map<string, string>>;
    r2: Set<string>;
    r2Objects: Map<string, Set<string>>;
    staleReads: Map<string, string>;
    workers: Map<string, string | undefined>;
} => {
    const d1 = new Map<string, string>();
    const kv = new Map<string, string>();
    const kvValues = new Map<string, Map<string, string>>();
    const r2 = new Set<string>();
    const r2Objects = new Map<string, Set<string>>();
    let hiddenKvListings = options.hiddenKvListings ?? 0;
    const staleReads = new Map<string, string>();
    const workers = new Map<string, string | undefined>();
    const calls: { method: string; path: string }[] = [];
    let sequence = 0;
    const nextId = (prefix: string): string => {
        sequence += 1;

        return `${prefix}-${String(sequence)}`;
    };

    const kvKeysRoute = (path: string, search: URLSearchParams): Response | undefined => {
        const keys = KV_KEYS_PATH.exec(path);

        if (keys !== null) {
            const prefix = search.get("prefix") ?? "";
            const matching = [...(kvValues.get(keys[1] ?? "")?.keys() ?? [])].filter((key) => key.startsWith(prefix));
            const start = Number(search.get("cursor") ?? "0");
            const size = options.keysPageSize ?? matching.length;
            const next = start + size < matching.length ? String(start + size) : "";

            return json({
                errors: [],
                result: matching.slice(start, start + size).map((name) => {
                    return { name };
                }),
                result_info: { count: Math.min(size, matching.length - start), cursor: next },
                success: true,
            });
        }

        return undefined;
    };

    const kvNamespacesRoute = (method: string, path: string, body: string | undefined): Response | undefined => {
        if (path === "/storage/kv/namespaces") {
            if (method === "POST") {
                const { title } = JSON.parse(body ?? "{}") as { title: string };

                // Cloudflare refuses a second namespace with the same title.
                if ([...kv.values()].includes(title)) {
                    return json({ errors: [{ code: 10_014, message: "a namespace with this account ID and title already exists" }], success: false }, 400);
                }

                const id = nextId("kv");

                kv.set(id, title);

                return envelope({ id });
            }

            if (hiddenKvListings > 0) {
                hiddenKvListings -= 1;

                return envelope([]);
            }

            return envelope(
                [...kv].map(([id, title]) => {
                    return { id, title };
                }),
            );
        }

        return undefined;
    };

    const kvValueRoute = (method: string, value: RegExpExecArray, body: string | undefined): Response => {
        const values = kvValues.get(value[1] ?? "") ?? new Map<string, string>();
        const key = decodeURIComponent(value[2] ?? "");

        kvValues.set(value[1] ?? "", values);

        if (method === "PUT") {
            values.set(key, body ?? "");

            return envelope(null);
        }

        if (method === "DELETE") {
            values.delete(key);

            return envelope(null);
        }

        const stale = staleReads.get(key);

        // One read served from a location that has not seen the latest write yet.
        if (stale !== undefined) {
            staleReads.delete(key);

            return new Response(stale, { status: 200 });
        }

        const stored = values.get(key);

        return stored === undefined ? notFound() : new Response(stored, { status: 200 });
    };

    const kvRoute = (method: string, path: string, search: URLSearchParams, body: string | undefined): Response | undefined => {
        const value = KV_VALUE_PATH.exec(path);

        if (value !== null) {
            return kvValueRoute(method, value, body);
        }

        const namespace = KV_NAMESPACE_PATH.exec(path);

        if (namespace !== null) {
            const id = namespace[1] ?? "";

            if (method === "DELETE") {
                return kv.delete(id) ? envelope(null) : notFound();
            }

            return kv.has(id) ? envelope({ id, title: kv.get(id) }) : notFound();
        }

        return kvKeysRoute(path, search) ?? kvNamespacesRoute(method, path, body);
    };

    const storageRoute = (method: string, path: string, search: URLSearchParams, body: string | undefined): Response | undefined => {
        if (path === "/d1/database") {
            if (method === "POST") {
                const uuid = nextId("d1");

                d1.set((JSON.parse(body ?? "{}") as { name: string }).name, uuid);

                return envelope({ uuid });
            }

            return envelope(
                [...d1]
                    .filter(([name]) => name === search.get("name"))
                    .map(([name, uuid]) => {
                        return { name, uuid };
                    }),
            );
        }

        const database = D1_PATH.exec(path);

        if (database !== null) {
            const entry = [...d1].find(([, uuid]) => uuid === database[1]);

            if (method === "DELETE") {
                return entry !== undefined && d1.delete(entry[0]) ? envelope(null) : notFound();
            }

            return entry === undefined ? notFound() : envelope({ name: entry[0], uuid: entry[1] });
        }

        return undefined;
    };

    const r2ObjectsRoute = (method: string, path: string): Response | undefined => {
        const objects = R2_OBJECTS_PATH.exec(path);

        if (objects !== null) {
            const name = decodeURIComponent(objects[1] ?? "");

            return r2.has(name)
                ? envelope(
                      [...(r2Objects.get(name) ?? [])].slice(0, 2).map((key) => {
                          return { key };
                      }),
                  )
                : notFound();
        }

        const object = R2_OBJECT_PATH.exec(path);

        if (object !== null && method === "DELETE") {
            const keys = r2Objects.get(decodeURIComponent(object[1] ?? ""));
            const key = (object[2] ?? "")
                .split("/")
                .map((segment) => decodeURIComponent(segment))
                .join("/");

            return keys?.delete(key) === true ? envelope({ key }) : notFound();
        }

        return undefined;
    };

    const r2Route = (method: string, path: string, body: string | undefined): Response | undefined => {
        if (path === "/r2/buckets" && method === "POST") {
            r2.add((JSON.parse(body ?? "{}") as { name: string }).name);

            return envelope({});
        }

        const objectsRouted = r2ObjectsRoute(method, path);

        if (objectsRouted !== undefined) {
            return objectsRouted;
        }

        const bucket = R2_PATH.exec(path);

        if (bucket !== null) {
            const name = decodeURIComponent(bucket[1] ?? "");

            if (method === "DELETE") {
                // R2 refuses to delete a bucket that still holds objects.
                if ((r2Objects.get(name)?.size ?? 0) > 0) {
                    return json({ errors: [{ code: 10_008, message: "The bucket you tried to delete is not empty" }], success: false }, 409);
                }

                return r2.delete(name) ? envelope(null) : notFound();
            }

            return r2.has(name) ? envelope({ name }) : notFound();
        }

        return undefined;
    };

    const handle = (method: string, path: string, search: URLSearchParams, body: string | undefined): Response => {
        if (path === "/workers/subdomain") {
            return envelope({ subdomain: "acme" });
        }

        const settings = SCRIPT_SETTINGS_PATH.exec(path);

        if (settings !== null) {
            const name = decodeURIComponent(settings[1] ?? "");

            if (!workers.has(name)) {
                return notFound();
            }

            const marker = workers.get(name);

            return envelope({ bindings: marker === undefined ? [] : [{ name: "LUNORA_PREVIEW", text: marker, type: "plain_text" }] });
        }

        const script = SCRIPT_PATH.exec(path);

        if (script !== null && method === "DELETE") {
            return workers.delete(decodeURIComponent(script[1] ?? "")) ? envelope(null) : notFound();
        }

        const routed = kvRoute(method, path, search, body) ?? storageRoute(method, path, search, body) ?? r2Route(method, path, body);

        if (routed !== undefined) {
            return routed;
        }

        return json({ errors: [{ message: `unexpected ${method} ${path}` }], success: false }, 500);
    };

    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input as string);
        const path = url.pathname.replace(ACCOUNT_PREFIX, "");
        const method = init?.method ?? "GET";

        calls.push({ method, path });

        return handle(method, path, url.searchParams, typeof init?.body === "string" ? init.body : undefined);
    }) as typeof globalThis.fetch;

    return { calls, d1, fetch, kv, kvValues, r2, r2Objects, staleReads, workers };
};

const PREVIEW_DEPLOY_OUTPUT = `Uploaded lunora-app-preview-42 (2.21 sec)
  https://lunora-app-preview-42.acme.workers.dev
Current Version ID: 1f2e3d4c-5b6a-7089-9a0b-1c2d3e4f5a6b
`;

/** A wrangler stand-in that records, at the moment `wrangler deploy` runs, the config and secrets file it would read. */
const wranglerAt = (
    workdir: string,
    workers: Map<string, string | undefined>,
): { deploys: { args: ReadonlyArray<string>; secrets: Record<string, string>; wrangler: PreviewConfig }[]; spawner: Spawner } => {
    const deploys: { args: ReadonlyArray<string>; secrets: Record<string, string>; wrangler: PreviewConfig }[] = [];
    const spawner: Spawner = async (descriptor) => {
        const { args } = descriptor;

        if (args.includes("deploy") && args.includes("--env")) {
            const secretsPath = args[args.indexOf("--secrets-file") + 1] ?? "";

            deploys.push({
                args,
                secrets: JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, string>,
                wrangler: parseJsonc(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")) as PreviewConfig,
            });
            const environment = String(args[args.indexOf("--env") + 1]);
            const block = deploys.at(-1)?.wrangler.env?.[environment] as { name: string; vars?: Record<string, string> };

            workers.set(block.name, block.vars?.LUNORA_PREVIEW);
        }

        const captured = descriptor.captureStdout === true || descriptor.captureStdoutSilently === true;

        return { code: 0, stdout: captured ? PREVIEW_DEPLOY_OUTPUT : undefined };
    };

    return { deploys, spawner };
};

const PREVIEW_URL = "https://lunora-app-preview-42.acme.workers.dev";

const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" };

/** Admin RPCs (migrations, seed) answered OK, with where they went and the bearer they carried. */
const adminRecorder = (): { calls: { authorization?: string; url: string }[]; fetch: StreamingFetchLike } => {
    const calls: { authorization?: string; url: string }[] = [];

    return {
        calls,
        fetch: async (url, init) => {
            calls.push({ authorization: init?.headers?.Authorization ?? init?.headers?.authorization, url });

            return {
                body: null,
                json: async () => {
                    return { status: "ok" };
                },
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ status: "ok" }),
            };
        },
    };
};

const planOf = (config: PreviewConfig, name: string): PreviewPlan => {
    const planned = planPreview(config, name);

    if (planned.plan === undefined) {
        throw new Error(planned.error);
    }

    return planned.plan;
};

const healthy = async (): Promise<{ ok: boolean; status: number }> => {
    return { ok: true, status: 200 };
};

describe("lunora preview", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-preview-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), PRODUCTION_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("plan", () => {
        const production = parseJsonc(PRODUCTION_WRANGLER) as PreviewConfig;

        it("sanitizes the preview name into Cloudflare's alphabet and length", () => {
            expect.assertions(5);

            const { names } = previewNames(production, "Feature/Login_Flow!!");

            expect(names?.slug).toBe("feature-login-flow");
            expect(names?.worker).toBe("lunora-app-preview-feature-login-flow");

            const long = previewNames(production, "x".repeat(200)).names?.worker ?? "";

            expect(long.length).toBeLessThanOrEqual(63);
            expect(long).toMatch(/^[a-z0-9-]+$/u);
            expect(previewNames(production, "!!!").error).toMatch(/no letter or digit/u);
        });

        it("rewrites every resource onto a preview-owned one: no production id, name, route or Worker reaches the env block", () => {
            expect.assertions(17);

            const plan = planOf(production, "42");

            const ids = new Map(plan.resources.map((resource) => [resourceKey(resource.kind, resource.binding), `preview-id-${resource.binding}`]));
            const block = previewEnvironmentBlock(production, plan, ids);
            const serialized = JSON.stringify(block);

            for (const identity of PRODUCTION_IDENTITIES) {
                expect(serialized).not.toContain(`"${identity}"`);
            }

            // Inheritable routes and custom domains are overridden, not inherited.
            expect(block.routes).toStrictEqual([]);
            expect(block.workers_dev).toBe(true);
            expect(block.name).toBe("lunora-app-preview-42");
            expect(block.d1_databases).toStrictEqual([{ binding: "DB", database_id: "preview-id-DB", database_name: "lunora-app-preview-42-db" }]);
            // Production's vars, plus the marker `delete` checks before it removes the Worker.
            expect(block.vars).toStrictEqual({ LUNORA_PREVIEW: "lunora-app/42", PUBLIC_FLAG: "on" });
        });

        it("overwrites the block an interrupted run left behind, but never an environment of the user's own", () => {
            expect.assertions(2);

            const leftover = {
                ...production,
                env: { "preview-42": { name: "lunora-app-preview-42", vars: { LUNORA_PREVIEW: "lunora-app/42" } } },
            } as PreviewConfig;
            const owned = { ...production, env: { "preview-42": { name: "lunora-app-qa" } } } as PreviewConfig;

            expect(planPreview(leftover, "42").plan?.worker).toBe("lunora-app-preview-42");
            expect(planPreview(owned, "42").error).toMatch(/already declares "env.preview-42"/u);
        });

        it("clears production's cron triggers, which wrangler would otherwise inherit into every preview", () => {
            expect.assertions(1);

            const withCrons = { ...production, triggers: { crons: ["0 3 * * *"] } } as PreviewConfig;
            const plan = planOf(withCrons, "42");
            const ids = new Map(plan.resources.map((resource) => [resourceKey(resource.kind, resource.binding), `preview-id-${resource.binding}`]));

            expect(previewEnvironmentBlock(withCrons, plan, ids).triggers).toStrictEqual({ crons: [] });
        });

        it("refuses bindings whose names differ only by case, which would share one preview resource", () => {
            expect.assertions(1);

            const twoDatabases = {
                ...production,
                d1_databases: [
                    { binding: "DB", database_id: "prod-d1-uuid", database_name: "prod-db" },
                    { binding: "db", database_id: "other-uuid", database_name: "other-db" },
                ],
            } as PreviewConfig;

            expect(planPreview(twoDatabases, "42").error).toMatch(/two bindings would share the preview resource name "lunora-app-preview-42-db"/u);
        });

        it("copies the build-time constants, which wrangler does not inherit into an environment", () => {
            expect.assertions(1);

            const withDefine = { ...production, define: { __APP_VERSION__: '"1.2.3"' } } as PreviewConfig;
            const plan = planOf(withDefine, "42");
            const ids = new Map(plan.resources.map((resource) => [resourceKey(resource.kind, resource.binding), `preview-id-${resource.binding}`]));

            expect(previewEnvironmentBlock(withDefine, plan, ids).define).toStrictEqual({ __APP_VERSION__: '"1.2.3"' });
        });

        it("applies --var overrides over production's vars, under the marker", () => {
            expect.assertions(1);

            const plan = planOf(production, "42");
            const ids = new Map(plan.resources.map((resource) => [resourceKey(resource.kind, resource.binding), `preview-id-${resource.binding}`]));

            expect(previewEnvironmentBlock(production, plan, ids, { LUNORA_PREVIEW: "spoofed", PUBLIC_FLAG: "off" }).vars).toStrictEqual({
                LUNORA_PREVIEW: "lunora-app/42",
                PUBLIC_FLAG: "off",
            });
        });

        it("treats a marked environment as a preview's only when its key, Worker name and marker all match", () => {
            expect.assertions(2);

            // The user's own environment that happens to carry the marker var, for another preview.
            const foreign = {
                ...production,
                env: { "preview-42": { name: "lunora-app-preview-42", vars: { LUNORA_PREVIEW: "lunora-app/7" } } },
            } as PreviewConfig;
            // A marked environment of the user's: its identities stay production's.
            const marked = {
                ...production,
                env: {
                    qa: {
                        d1_databases: [{ binding: "DB", database_id: "qa-d1-uuid", database_name: "qa-db" }],
                        name: "lunora-app-qa",
                        vars: { LUNORA_PREVIEW: "lunora-app/qa" },
                    },
                },
            } as PreviewConfig;

            expect(planPreview(foreign, "42").error).toMatch(/already declares "env.preview-42"/u);
            expect(productionCollisions(marked, ["qa-d1-uuid"])).toStrictEqual(["qa-d1-uuid"]);
        });

        it.each([
            ["hyperdrive", { hyperdrive: [{ binding: "PG", id: "prod-hd" }] }],
            ["services", { services: [{ binding: "API", service: "billing" }] }],
            ["queues", { queues: { producers: [{ binding: "JOBS", queue: "jobs" }] } }],
            ["vectorize", { vectorize: [{ binding: "VEC", index_name: "prod-index" }] }],
            ["workflows", { workflows: [{ binding: "FLOW", class_name: "Flow", name: "flow" }] }],
            ["an unknown binding", { some_future_binding: [{ binding: "X" }] }],
            ["a Durable Object on another Worker", { durable_objects: { bindings: [{ class_name: "Billing", name: "BILL", script_name: "billing" }] } }],
            ["a singular route", { route: "app.example.com/*" }],
            ["the Analytics SQL binding, which reads the account's datasets", { analytics: { binding: "ANALYTICS" } }],
        ])("refuses an app that binds %s rather than share production's resource", (_label, extra) => {
            expect.assertions(1);

            expect(planPreview({ ...production, ...extra }, "42").error).toMatch(/cannot be previewed in isolation/u);
        });
    });

    const deployWith = async (account: ReturnType<typeof fakeAccount>, spawner: Spawner): Promise<Awaited<ReturnType<typeof runPreviewCommand>>> =>
        runPreviewCommand({
            adminFetch: adminRecorder().fetch,
            cwd: workdir,
            environment: CREDENTIALS,
            fetch: account.fetch,
            healthFetch: healthy,
            logger: silentLogger().logger,
            name: "42",
            spawner,
            subcommand: "deploy",
        });

    describe("deploy", () => {
        it("deploys its own Worker on its own D1, KV and R2, records them, and leaves the committed config and production's link alone", async () => {
            expect.assertions(15);

            // A committed baseline one table behind the branch: a production deploy would advance it.
            runCodegen({ projectRoot: workdir, ...wranglerCodegenInputs(workdir) });

            const baselinePath = join(workdir, "lunora", ".lunora-schema.json");
            const current = JSON.parse(readFileSync(baselinePath, "utf8")) as { tables: Record<string, unknown> };
            const baseline = { ...current, tables: Object.fromEntries(Object.entries(current.tables).slice(1)) };

            const committedBaseline = `${JSON.stringify(baseline, undefined, 2)}\n`;

            writeFileSync(baselinePath, committedBaseline, "utf8");

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const admin = adminRecorder();
            const { logger } = silentLogger();

            const result = await runPreviewCommand({
                adminFetch: admin.fetch,
                cwd: workdir,
                environment: { ...CREDENTIALS, RESEND_API_KEY: "re_live_secret" },
                fetch: account.fetch,
                healthFetch: healthy,
                logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result).toMatchObject({
                code: 0,
                data: { preview: { url: "https://lunora-app-preview-42.acme.workers.dev", worker: "lunora-app-preview-42" } },
            });
            expect(deploys).toHaveLength(1);

            const [deployed] = deploys;
            const block = deployed?.wrangler.env?.["preview-42"] as Record<string, unknown>;
            const serialized = JSON.stringify(block);

            expect(deployed?.args).toStrictEqual(expect.arrayContaining(["--env", "preview-42", "--secrets-file"]));

            for (const identity of ["prod-d1-uuid", "prod-kv-id", "prod-files", "app.example.com"]) {
                expect(serialized).not.toContain(identity);
            }

            expect(block.d1_databases).toStrictEqual([
                { binding: "DB", database_id: account.d1.get("lunora-app-preview-42-db"), database_name: "lunora-app-preview-42-db" },
            ]);
            // A fresh admin token, and nothing the user did not opt into.
            expect(Object.keys(deployed?.secrets ?? {})).not.toContain("RESEND_API_KEY");
            // Migrations ran against the preview, with the preview's own token.
            expect(admin.calls.length).toBeGreaterThan(0);
            expect(admin.calls.every((call) => call.url.startsWith("https://lunora-app-preview-42.acme.workers.dev"))).toBe(true);
            expect(admin.calls[0]?.authorization).toBe(`Bearer ${deployed?.secrets.LUNORA_ADMIN_TOKEN ?? "missing"}`);
            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(PRODUCTION_WRANGLER);
            expect(existsSync(join(workdir, ".lunora", "project.json"))).toBe(false);
            // Production's schema baseline is not advanced by a branch's preview.
            expect(readFileSync(baselinePath, "utf8")).toBe(committedBaseline);
        });

        it("records every resource it created, so a fresh runner can delete them", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { spawner } = wranglerAt(workdir, account.workers);
            const { logger } = silentLogger();

            await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const record = JSON.parse(account.kvValues.get(registry)?.get("lunora-app/42") ?? "{}") as { resources: { kind: string; name: string }[] };

            expect(record.resources.map((resource) => `${resource.kind}:${resource.name}`).toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
                "d1:lunora-app-preview-42-db",
                "kv:lunora-app-preview-42-cache",
                "r2:lunora-app-preview-42-files",
            ]);

            // A second deploy reuses them instead of making new ones.
            await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(account.calls.filter((call) => call.method === "POST")).toHaveLength(4);
        });

        it("copies a secret only when the user opts in with --secret", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const { logger } = silentLogger();

            await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: { ...CREDENTIALS, RESEND_API_KEY: "re_test" },
                fetch: account.fetch,
                healthFetch: healthy,
                logger,
                name: "42",
                secrets: ["RESEND_API_KEY"],
                spawner,
                subcommand: "deploy",
            });

            expect(deploys[0]?.secrets.RESEND_API_KEY).toBe("re_test");
            expect(deploys[0]?.secrets.LUNORA_ADMIN_TOKEN).toMatch(/^[0-9a-f]{32,}$/u);
        });

        it("refuses to adopt an existing resource it has no record of", async () => {
            expect.assertions(3);

            const account = fakeAccount();

            account.d1.set("lunora-app-preview-42-db", "someone-elses-uuid");

            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const { logger } = silentLogger();

            const result = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result).toMatchObject({ code: EXIT_CODE.FAILURE, error: expect.stringMatching(/already exist\(s\) but no preview record/u) });
            expect(deploys).toHaveLength(0);
            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(PRODUCTION_WRANGLER);
        });

        it("refuses to deploy over an existing Worker it did not deploy, before creating anything", async () => {
            expect.assertions(3);

            const account = fakeAccount();

            account.workers.set("lunora-app-preview-42", undefined);

            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const { logger } = silentLogger();

            const result = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result.error).toMatch(/Worker named "lunora-app-preview-42" already exists and was not deployed as preview "42"/u);
            expect(account.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
            expect(deploys).toHaveLength(0);
        });

        it("refuses to deploy over a marked Worker that has no preview record, before creating any resource", async () => {
            expect.assertions(3);

            const account = fakeAccount();

            // The marker is a var anyone can set; the record is what shows ownership.
            account.workers.set("lunora-app-preview-42", "lunora-app/42");

            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const result = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result.error).toMatch(/exists but no preview record says this preview deployed it/u);
            expect(account.calls.filter((call) => call.method === "POST" || call.method === "PUT")).toHaveLength(1);
            expect(deploys).toHaveLength(0);
        });

        it("refuses an app that declares lunora.config services, which a preview would share with production", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "lunora.config.ts"), `export default { services: { parser: { dir: "./services/parser" } } };\n`, "utf8");
            mkdirSync(join(workdir, "services", "parser"), { recursive: true });
            writeFileSync(join(workdir, "services", "parser", "wrangler.jsonc"), `{ "name": "parser", "main": "src/index.ts" }\n`, "utf8");

            const account = fakeAccount();
            const { logger } = silentLogger();

            const result = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, name: "42", subcommand: "deploy" });

            expect(result.error).toMatch(/declares lunora.config services \(parser\)/u);
            expect(account.calls).toHaveLength(0);
        });

        it("refuses a config's required secret that was not passed with --secret, before creating anything", async () => {
            expect.assertions(2);

            writeFileSync(
                join(workdir, "wrangler.jsonc"),
                PRODUCTION_WRANGLER.replace(`"vars":`, `"secrets": { "required": ["STRIPE_KEY"] },\n    "vars":`),
                "utf8",
            );

            const account = fakeAccount();
            const { logger } = silentLogger();

            const result = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, name: "42", subcommand: "deploy" });

            expect(result.error).toMatch(/requires STRIPE_KEY.*--secret STRIPE_KEY/u);
            expect(account.calls).toHaveLength(0);
        });

        it("mints a mintable secret the project declares locally, but never a provider key", async () => {
            expect.assertions(2);

            writeFileSync(join(workdir, ".dev.vars"), `${["BETTER_AUTH_SECRET=local", "STRIPE_SECRET_KEY=sk_test"].join("\n")}\n`, "utf8");

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);

            await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(deploys[0]?.secrets.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/u);
            expect(Object.keys(deploys[0]?.secrets ?? {})).not.toContain("STRIPE_SECRET_KEY");
        });

        it("leaves no schema baseline behind in a checkout that had none", async () => {
            expect.assertions(2);

            const baselinePath = join(workdir, "lunora", ".lunora-schema.json");

            rmSync(baselinePath, { force: true });

            const account = fakeAccount();
            const { spawner } = wranglerAt(workdir, account.workers);
            const result = await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result.code).toBe(0);
            expect(existsSync(baselinePath)).toBe(false);
        });

        it("deploys the --var overrides with the preview", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);

            const result = await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
                vars: ["PUBLIC_FLAG=off", `AUTH_URL=${PREVIEW_URL}`],
            });

            expect(result.code).toBe(0);
            expect((deploys[0]?.wrangler.env?.["preview-42"] as { vars: Record<string, string> }).vars).toStrictEqual({
                AUTH_URL: PREVIEW_URL,
                LUNORA_PREVIEW: "lunora-app/42",
                PUBLIC_FLAG: "off",
            });
        });

        it("refuses a --var that would replace the preview marker", async () => {
            expect.assertions(1);

            const result = await runPreviewCommand({
                cwd: workdir,
                dryRun: true,
                environment: CREDENTIALS,
                logger: silentLogger().logger,
                name: "42",
                subcommand: "deploy",
                vars: [["LUNORA_PREVIEW", "lunora-app/7"].join("=")],
            });

            expect(result.error).toMatch(/the preview sets LUNORA_PREVIEW itself/u);
        });

        it("derives minted secrets from LUNORA_PREVIEW_SECRET_SEED, so a redeploy keeps them; without it each deploy mints afresh", async () => {
            expect.assertions(3);

            const tokens = async (environment: Record<string, string>): Promise<(string | undefined)[]> => {
                const account = fakeAccount();
                const { deploys, spawner } = wranglerAt(workdir, account.workers);

                for (let run = 0; run < 2; run += 1) {
                    // eslint-disable-next-line no-await-in-loop -- the second deploy is the redeploy
                    await runPreviewCommand({
                        adminFetch: adminRecorder().fetch,
                        cwd: workdir,
                        environment,
                        fetch: account.fetch,
                        healthFetch: healthy,
                        logger: silentLogger().logger,
                        name: "42",
                        spawner,
                        subcommand: "deploy",
                    });
                }

                return deploys.map((deploy) => deploy.secrets.LUNORA_ADMIN_TOKEN);
            };

            const seeded = await tokens({ ...CREDENTIALS, LUNORA_PREVIEW_SECRET_SEED: "ci-seed" });
            const fresh = await tokens({ ...CREDENTIALS, LUNORA_PREVIEW_SECRET_SEED: "" });

            expect(seeded[0]).toMatch(/^[0-9a-f]{64}$/u);
            expect(seeded[1]).toBe(seeded[0]);
            expect(fresh[1]).not.toBe(fresh[0]);
        });

        it("stops before writing when a stale read of the record misses a resource an earlier deploy made", async () => {
            expect.assertions(3);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const deploy = async (): Promise<Awaited<ReturnType<typeof runPreviewCommand>>> => deployWith(account, spawner);

            await deploy();

            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const current = account.kvValues.get(registry)?.get("lunora-app/42") ?? "";
            const parsed = JSON.parse(current) as { resources: { kind: string }[] };

            // One read is served a copy written before the R2 bucket was recorded.
            account.staleReads.set("lunora-app/42", JSON.stringify({ ...parsed, resources: parsed.resources.filter((resource) => resource.kind !== "r2") }));

            const result = await deploy();

            expect(result.error).toMatch(/r2 "lunora-app-preview-42-files" already exist\(s\) but no preview record read/u);
            expect(account.kvValues.get(registry)?.get("lunora-app/42")).toBe(current);
            expect(deploys).toHaveLength(1);
        });

        it("refuses to rebind a recorded resource whose id now names a different resource", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const deploy = async (): Promise<Awaited<ReturnType<typeof runPreviewCommand>>> => deployWith(account, spawner);

            await deploy();

            // The recorded uuid now belongs to an unrelated database.
            const uuid = account.d1.get("lunora-app-preview-42-db") ?? "";

            account.d1.delete("lunora-app-preview-42-db");
            account.d1.set("billing-db", uuid);

            const result = await deploy();

            expect(result.error).toMatch(/now a different resource/u);
            expect(deploys).toHaveLength(1);
        });

        it("writes to the registry another first deploy created while this one was looking", async () => {
            expect.assertions(2);

            // The first namespace listing misses the registry; the create is then refused as a duplicate title.
            const account = fakeAccount({ hiddenKvListings: 1 });

            account.kv.set("kv-registry", "lunora-preview-registry");

            const { spawner } = wranglerAt(workdir, account.workers);
            const result = await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result.code).toBe(0);
            expect(account.kvValues.get("kv-registry")?.has("lunora-app/42")).toBe(true);
        });

        it("--dry-run shows the plan without calling Cloudflare or deploying", async () => {
            expect.assertions(4);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            const { infos, logger } = silentLogger();

            const result = await runPreviewCommand({
                cwd: workdir,
                dryRun: true,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result.code).toBe(0);
            expect(account.calls).toHaveLength(0);
            expect(deploys).toHaveLength(0);
            expect(infos.join("\n")).toContain('d1 "lunora-app-preview-42-db" for DB');
        });

        it("refuses a --secret that has no value in the environment, before touching the account", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { logger } = silentLogger();

            const result = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                secrets: ["STRIPE_KEY"],
                subcommand: "deploy",
            });

            expect(result.error).toMatch(/STRIPE_KEY is not set/u);
            expect(account.calls).toHaveLength(0);
        });

        it.each([
            ["celld", /celld has no isolated previews/u],
            ["node", /Node target has no `lunora deploy`/u],
        ])("refuses the %s target with what to do instead", async (target, message) => {
            expect.assertions(1);

            const { logger } = silentLogger();

            await expect(
                runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, logger, name: "42", subcommand: "deploy", target }),
            ).resolves.toMatchObject({
                code: EXIT_CODE.USAGE,
                error: expect.stringMatching(message),
            });
        });
    });

    describe("command line", () => {
        it("reads the subcommand, the name and every --secret from the real argv", async () => {
            expect.assertions(3);

            const lines: string[] = [];
            const push = (...parts: unknown[]): void => {
                lines.push(parts.map(String).join(" "));
            };

            const code = await runCli({
                argv: ["preview", "deploy", "42", "--dry-run", "--secret", "ALPHA_KEY", "--secret", "BETA_KEY"],
                cwd: workdir,
                logger: { debug: push, error: push, info: push, log: push, warn: push } as unknown as Console,
            });
            const output = lines.join("\n");

            expect(code).toBe(0);
            expect(output).toContain('Worker "lunora-app-preview-42"');
            expect(output).toContain("from the environment: ALPHA_KEY, BETA_KEY");
        });
    });

    describe("delete", () => {
        const deployed = async (): Promise<ReturnType<typeof fakeAccount>> => {
            const account = fakeAccount();
            const { spawner } = wranglerAt(workdir, account.workers);

            await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            return account;
        };

        it("deletes the Worker and every recorded resource, then the record; list no longer shows it", async () => {
            expect.assertions(6);

            const account = await deployed();
            const { logger } = silentLogger();

            const result = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, name: "42", subcommand: "delete" });

            expect(result.code).toBe(0);
            expect(account.workers.size).toBe(0);
            expect(account.d1.size).toBe(0);
            expect(account.r2.size).toBe(0);
            // Only the registry namespace is left.
            expect([...account.kv.values()]).toStrictEqual(["lunora-preview-registry"]);

            const listed = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, subcommand: "list" });

            expect(listed.data?.previews).toStrictEqual([]);
        });

        it("refuses a preview that is not on record, and deletes nothing", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { logger } = silentLogger();

            const result = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, name: "42", subcommand: "delete" });

            expect(result.code).toBe(EXIT_CODE.NOT_FOUND);
            expect(account.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
        });

        it("refuses a record that names a production resource, and deletes nothing", async () => {
            expect.assertions(2);

            const account = await deployed();
            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const values = account.kvValues.get(registry);
            const record = JSON.parse(values?.get("lunora-app/42") ?? "{}") as { resources: { id: string; kind: string }[] };

            record.resources = record.resources.map((resource) => (resource.kind === "d1" ? { ...resource, id: "prod-d1-uuid" } : resource));
            values?.set("lunora-app/42", JSON.stringify(record));
            account.calls.length = 0;

            const result = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger: silentLogger().logger,
                name: "42",
                subcommand: "delete",
            });

            expect(result.error).toMatch(/production's prod-d1-uuid; refusing to delete anything/u);
            expect(account.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
        });

        it("refuses to delete a Worker by the preview's name that the preview did not deploy, and deletes nothing", async () => {
            expect.assertions(3);

            const account = await deployed();

            // Someone else's Worker now holds the name.
            account.workers.set("lunora-app-preview-42", undefined);
            account.calls.length = 0;

            const result = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger: silentLogger().logger,
                name: "42",
                subcommand: "delete",
            });

            expect(result.error).toMatch(/was not deployed as preview "42"; refusing to delete anything/u);
            expect(account.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
            expect(account.workers.has("lunora-app-preview-42")).toBe(true);
        });

        const recordOf = (
            account: ReturnType<typeof fakeAccount>,
        ): { set: (record: unknown) => void; value: Record<string, unknown> & { resources: Record<string, string>[] } } => {
            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const values = account.kvValues.get(registry);

            return {
                set: (record) => values?.set("lunora-app/42", JSON.stringify(record)),
                value: JSON.parse(values?.get("lunora-app/42") ?? "{}") as Record<string, unknown> & { resources: Record<string, string>[] },
            };
        };

        const deleteIt = async (account: ReturnType<typeof fakeAccount>): Promise<Awaited<ReturnType<typeof runPreviewCommand>>> =>
            runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger: silentLogger().logger,
                name: "42",
                subcommand: "delete",
            });

        it("refuses a record whose resource id now names an unrelated resource, and deletes nothing", async () => {
            expect.assertions(3);

            const account = await deployed();
            const record = recordOf(account);

            // An edited record: the D1 entry keeps the preview's name but points at someone else's database.
            account.d1.set("billing-db", "billing-uuid");
            record.set({
                ...record.value,
                resources: record.value.resources.map((resource) => (resource.kind === "d1" ? { ...resource, id: "billing-uuid" } : resource)),
            });
            account.calls.length = 0;

            const result = await deleteIt(account);

            expect(result.error).toMatch(/d1 billing-uuid, which no longer name\(s\) the recorded resource/u);
            expect(account.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
            expect(account.d1.has("billing-db")).toBe(true);
        });

        it("refuses a record that names another preview, whose registry key it would otherwise delete", async () => {
            expect.assertions(2);

            const account = await deployed();
            const record = recordOf(account);

            record.set({ ...record.value, name: "7" });
            // The Worker is already gone, so its marker cannot catch the mismatch.
            account.workers.clear();
            account.kvValues.get([...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "")?.set("lunora-app/7", "{}");
            account.calls.length = 0;

            const result = await deleteIt(account);

            expect(result.error).toMatch(/refusing to delete anything/u);
            expect(account.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
        });

        it("refuses a record with a resource this CLI could not have written", async () => {
            expect.assertions(2);

            const account = await deployed();
            const record = recordOf(account);

            record.set({
                ...record.value,
                resources: [...record.value.resources, { binding: "PG", id: "prod-hd", kind: "hyperdrive", name: "lunora-app-preview-42-pg" }],
            });
            account.calls.length = 0;

            const result = await deleteIt(account);

            expect(result.error).toMatch(/is not one this CLI wrote/u);
            expect(account.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
        });

        it("leaves the newer record alone when a stale read of it misses a resource, so a re-run deletes everything", async () => {
            expect.assertions(6);

            const account = await deployed();
            const record = recordOf(account);

            // One read is served a copy written before the R2 bucket was added to the record.
            account.staleReads.set(
                "lunora-app/42",
                JSON.stringify({ ...record.value, resources: record.value.resources.filter((resource) => resource.kind !== "r2") }),
            );

            const first = await deleteIt(account);

            expect(first.error).toMatch(/r2 "lunora-app-preview-42-files" exist\(s\) under this preview's names but not in the record read/u);
            expect(recordOf(account).value.resources.some((resource) => resource.kind === "r2")).toBe(true);
            expect(account.r2.has("lunora-app-preview-42-files")).toBe(true);

            const second = await deleteIt(account);

            expect(second.code).toBe(0);
            expect(account.r2.size).toBe(0);
            expect(recordOf(account).value.version).toBeUndefined();
        });

        it("empties a preview bucket that still holds objects, then deletes it", async () => {
            expect.assertions(3);

            const account = await deployed();

            account.r2Objects.set("lunora-app-preview-42-files", new Set(["a.txt", "uploads/b.png", "uploads/c d.png"]));

            const result = await deleteIt(account);

            expect(result.code).toBe(0);
            expect(account.r2.size).toBe(0);
            expect(account.r2Objects.get("lunora-app-preview-42-files")?.size).toBe(0);
        });

        it("lists the readable previews and names a registry key that is not a record, rather than failing", async () => {
            expect.assertions(3);

            const account = await deployed();
            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";

            account.kvValues.get(registry)?.set("lunora-app/hand-edited", JSON.stringify({ version: 1 }));

            const { logger, warns } = silentLogger();
            const listed = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, subcommand: "list" });

            expect(listed.code).toBe(0);
            expect(listed.data?.previews?.map((preview) => preview.name)).toStrictEqual(["42"]);
            expect(warns.join("\n")).toContain('"lunora-app/hand-edited" is not a preview record');
        });

        it("lists every recorded preview across pages of the registry's keys", async () => {
            expect.assertions(1);

            const account = await deployed();
            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const values = account.kvValues.get(registry);
            const template = JSON.parse(values?.get("lunora-app/42") ?? "{}") as Record<string, unknown>;

            // Records written straight into the registry: deploying each one would only make the test slow.
            for (const name of ["1", "2", "3", "4"]) {
                values?.set(`lunora-app/${name}`, JSON.stringify({ ...template, name, resources: [], worker: `lunora-app-preview-${name}` }));
            }

            const paged = fakeAccount({ keysPageSize: 2 });

            paged.kv.set(registry, "lunora-preview-registry");
            paged.kvValues.set(registry, values ?? new Map());

            const listed = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: paged.fetch,
                logger: silentLogger().logger,
                subcommand: "list",
            });

            expect(listed.data?.previews?.map((preview) => preview.name).toSorted()).toStrictEqual(["1", "2", "3", "4", "42"]);
        });

        it("--dry-run lists what would be deleted and deletes nothing", async () => {
            expect.assertions(2);

            const account = await deployed();

            account.calls.length = 0;

            const { infos, logger } = silentLogger();

            await runPreviewCommand({ cwd: workdir, dryRun: true, environment: CREDENTIALS, fetch: account.fetch, logger, name: "42", subcommand: "delete" });

            expect(infos.join("\n")).toContain('would delete Worker "lunora-app-preview-42"');
            expect(account.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
        });
    });
});
