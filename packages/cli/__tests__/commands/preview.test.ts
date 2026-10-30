import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import { wranglerCodegenInputs } from "@lunora/config/cloudflare";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareRestRequest } from "../../../../shared/cloudflare-rest";
import { runCli } from "../../src/cli";
import type { StreamingFetchLike } from "../../src/commands/data-transfer/shared";
import { runPreviewCommand } from "../../src/commands/preview/handler";
import type { PreviewConfig, PreviewPlan } from "../../src/commands/preview/plan";
import { planPreview, previewEnvironmentBlock, previewNames, productionCollisions, resourceKey } from "../../src/commands/preview/plan";
import { keepLease, lockDatabase, releaseLease, takeLease } from "../../src/commands/preview/registry";
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

/** The `lunora.appId` the fixture project commits; preview records are keyed by it. */
const APP_ID = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

const APP_MANIFEST = `{\n    "name": "lunora-app",\n    "dependencies": { "@lunora/d1": "*", "@lunora/storage": "*" },\n    "lunora": { "appId": "${APP_ID}" }\n}\n`;

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
const D1_QUERY_PATH = /^\/d1\/database\/([^/]+)\/query$/u;
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
    options: { foreignLockDatabase?: boolean; hiddenKvListings?: number; keysPageSize?: number; noSubdomain?: boolean } = {},
): {
    calls: { method: string; path: string }[];
    d1: Map<string, string>;
    fetch: typeof globalThis.fetch;
    kv: Map<string, string>;
    kvValues: Map<string, Map<string, string>>;
    /** The rows of the preview lock table, by `app_id/name`, and its clock in seconds. */
    locks: Map<string, { expires: number; owner: string }>;
    r2: Set<string>;
    r2Objects: Map<string, Set<string>>;
    staleReads: Map<string, string>;
    /** Every statement run against a D1 database through the query endpoint, by database name. */
    statements: { database: string; sql: string }[];
    workers: Map<string, string | undefined>;
} => {
    const d1 = new Map<string, string>();
    const kv = new Map<string, string>();
    const kvValues = new Map<string, Map<string, string>>();
    const r2 = new Set<string>();
    const r2Objects = new Map<string, Set<string>>();
    let hiddenKvListings = options.hiddenKvListings ?? 0;
    const staleReads = new Map<string, string>();
    const locks = new Map<string, { expires: number; owner: string }>();
    const statements: { database: string; sql: string }[] = [];
    // What each database holds, so a database the tooling did not make can be told from one it did.
    const databases = new Map<string, { marker?: string; tables: Set<string> }>();
    const workers = new Map<string, string | undefined>();
    const calls: { method: string; path: string }[] = [];
    let sequence = 0;
    const nextId = (prefix: string): string => {
        sequence += 1;

        return `${prefix}-${String(sequence)}`;
    };

    // One statement of the lock table, applied whole before the next request is seen, as D1 (one SQLite) does.
    // eslint-disable-next-line sonarjs/cognitive-complexity -- a fake that answers each statement the real query endpoint would run
    const lockStatement = (databaseId: string, body: string): Response => {
        const { params, sql } = JSON.parse(body) as { params: (number | string)[]; sql: string };
        const databaseName = [...d1].find(([, uuid]) => uuid === databaseId)?.[0] ?? databaseId;
        const state = databases.get(databaseId) ?? { tables: new Set<string>() };

        databases.set(databaseId, state);
        statements.push({ database: databaseName, sql });

        const now = Math.floor(Date.now() / 1000);
        const reply = (results: unknown[], changes: number): Response => envelope([{ meta: { changes }, results, success: true }]);

        if (sql.startsWith("SELECT name FROM sqlite_master")) {
            return reply(state.tables.has(String(params[0])) ? [{ name: params[0] }] : [], 0);
        }

        if (sql.startsWith("SELECT marker FROM")) {
            return reply(state.marker === undefined ? [] : [{ marker: state.marker }], 0);
        }

        if (sql.startsWith("CREATE TABLE IF NOT EXISTS lunora_preview_lock_owner")) {
            state.tables.add("lunora_preview_lock_owner");

            return reply([], 0);
        }

        if (sql.startsWith("INSERT INTO lunora_preview_lock_owner")) {
            state.marker = String(params[0]);

            return reply([], 1);
        }

        if (sql.startsWith("CREATE TABLE IF NOT EXISTS lunora_preview_locks")) {
            state.tables.add("lunora_preview_locks");

            return reply([], 0);
        }

        if (sql.startsWith("INSERT INTO lunora_preview_locks")) {
            const [app, name, owner, ttl] = params as [string, string, string, number];

            if (locks.has(`${app}/${name}`)) {
                return json(
                    {
                        errors: [
                            {
                                code: 7500,
                                message: "D1_ERROR: UNIQUE constraint failed: lunora_preview_locks.app_id, lunora_preview_locks.name: SQLITE_CONSTRAINT",
                            },
                        ],
                        success: false,
                    },
                    400,
                );
            }

            locks.set(`${app}/${name}`, { expires: now + ttl, owner });

            return reply([], 1);
        }

        if (sql.startsWith("SELECT owner_token")) {
            const row = locks.get(`${String(params[0])}/${String(params[1])}`);

            return reply(row === undefined ? [] : [{ expires_at: row.expires, now, owner_token: row.owner }], 0);
        }

        if (sql.startsWith("UPDATE lunora_preview_locks SET expires_at")) {
            const [ttl, app, name, owner] = params as [number, string, string, string];
            const row = locks.get(`${app}/${name}`);

            if (row?.owner !== owner) {
                return reply([], 0);
            }

            locks.set(`${app}/${name}`, { expires: now + ttl, owner });

            return reply([], 1);
        }

        if (sql.startsWith("UPDATE lunora_preview_locks")) {
            const [owner, ttl, app, name, stale] = params as [string, number, string, string, string];
            const row = locks.get(`${app}/${name}`);

            if (row?.owner !== stale || row.expires > now) {
                return reply([], 0);
            }

            locks.set(`${app}/${name}`, { expires: now + ttl, owner });

            return reply([], 1);
        }

        if (sql.startsWith("DELETE FROM lunora_preview_locks")) {
            const [app, name, owner] = params as [string, string, string];

            if (locks.get(`${app}/${name}`)?.owner === owner) {
                locks.delete(`${app}/${name}`);

                return reply([], 1);
            }

            return reply([], 0);
        }

        return json({ errors: [{ code: 7500, message: `unexpected statement: ${sql}` }], success: false }, 400);
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

        const query = D1_QUERY_PATH.exec(path);

        if (query !== null && method === "POST") {
            return lockStatement(query[1] ?? "", body ?? "{}");
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
            return envelope(options.noSubdomain === true ? {} : { subdomain: "acme" });
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

    if (options.foreignLockDatabase === true) {
        d1.set("lunora-preview-locks", "d1-foreign");
        databases.set("d1-foreign", { tables: new Set(["users"]) });
    }

    return { calls, d1, fetch, kv, kvValues, locks, r2, r2Objects, staleReads, statements, workers };
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

// Every deploy here runs the real pre-deploy pipeline (config load through Vite included), about a second
// each locally and several times that under coverage, and some cases deploy four times.
describe("lunora preview", { timeout: 120_000 }, () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-preview-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), PRODUCTION_WRANGLER, "utf8");
        writeFileSync(join(workdir, "package.json"), APP_MANIFEST, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("plan", () => {
        const production = parseJsonc(PRODUCTION_WRANGLER) as PreviewConfig;

        it("sanitizes the preview name into Cloudflare's alphabet and length", () => {
            expect.assertions(5);

            const { names } = previewNames(production, "Feature/Login_Flow!!");

            expect(names?.slug).toMatch(/^feature-login-flow-[0-9a-f]{6}$/u);
            expect(names?.worker).toBe(`lunora-app-preview-${names?.slug ?? ""}`);

            const long = previewNames(production, "x".repeat(200)).names?.worker ?? "";

            expect(long.length).toBeLessThanOrEqual(63);
            expect(long).toMatch(/^[a-z0-9-]+$/u);
            expect(previewNames(production, "!!!").error).toMatch(/no letter or digit/u);
        });

        it("gives names that clean to the same slug previews of their own", () => {
            expect.assertions(5);

            const slugs = ["foo_bar", "foo-bar", "Foo-Bar", "foo bar"].map((name) => previewNames(production, name).names?.slug);

            expect(new Set(slugs).size).toBe(4);
            expect(slugs[1]).toBe("foo-bar");
            // A name that needed no cleaning keeps its readable form, so PR numbers stay as they are.
            expect(previewNames(production, "42").names?.slug).toBe("42");
            // Cleaning the slug again changes nothing, which the marker check relies on.
            expect(previewNames(production, slugs[0] ?? "").names?.slug).toBe(slugs[0]);
            expect(previewNames(production, "foo_bar").names?.worker).not.toBe(previewNames(production, "foo-bar").names?.worker);
        });

        it("never lets a preview inherit production's LUNORA_ORIGIN_URL, which the scheduler dispatches to", () => {
            expect.assertions(4);

            const withOrigin = { ...production, vars: { ...production.vars, LUNORA_ORIGIN_URL: "https://app.example.com" } } as PreviewConfig;
            const plan = planPreview(withOrigin, "42").plan as PreviewPlan;
            const idsOf = (planned: PreviewPlan): Map<string, string> =>
                new Map(planned.resources.map((resource) => [resourceKey(resource.kind, resource.binding), `<${resource.name}>`]));
            const own = "https://lunora-app-preview-42.acme.workers.dev";
            const block = previewEnvironmentBlock(withOrigin, plan, idsOf(plan), {}, own) as { vars: Record<string, string> };

            expect(block.vars.LUNORA_ORIGIN_URL).toBe(own);
            expect(JSON.stringify(block)).not.toContain("app.example.com");
            // An explicit --var still wins; an app that never set it gets none.
            expect(
                (
                    previewEnvironmentBlock(withOrigin, plan, idsOf(plan), { LUNORA_ORIGIN_URL: "https://other.example" }, own) as {
                        vars: Record<string, string>;
                    }
                ).vars.LUNORA_ORIGIN_URL,
            ).toBe("https://other.example");
            expect(
                "LUNORA_ORIGIN_URL" in
                    (
                        previewEnvironmentBlock(
                            production,
                            planPreview(production, "42").plan as PreviewPlan,
                            idsOf(planPreview(production, "42").plan as PreviewPlan),
                            {},
                            own,
                        ) as { vars: object }
                    ).vars,
            ).toBe(false);
        });

        it("refuses an app whose bindings exist only inside an environment, which a preview planned from the top level would lack", () => {
            expect.assertions(2);

            const onlyInEnv = {
                ...production,
                env: { ...production.env, production: { kv_namespaces: [{ binding: "SESSIONS", id: "prod-sessions" }], name: "lunora-app-production" } },
                kv_namespaces: undefined,
            } as unknown as PreviewConfig;
            const { error } = planPreview(onlyInEnv, "42");

            expect(error).toMatch(/"env\.production\.kv_namespaces": declared only in this environment/u);
            // Overriding a binding that the top level also declares is the ordinary case and stays previewable.
            expect(planPreview(production, "42").error).toBeUndefined();
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
            ["a send_email binding, which would mail through production's sender", { send_email: [{ name: "MAIL" }] }],
        ])("refuses an app that binds %s rather than share production's resource", (_label, extra) => {
            expect.assertions(1);

            expect(planPreview({ ...production, ...extra }, "42").error).toMatch(/cannot be previewed in isolation/u);
        });
    });

    const registryValues = (account: ReturnType<typeof fakeAccount>): Map<string, string> =>
        account.kvValues.get([...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "") ?? new Map<string, string>();

    /** The account-changing calls of these methods, not counting the hold a run takes on its preview and lets go of. */
    const changes = (account: ReturnType<typeof fakeAccount>, ...methods: string[]): { method: string; path: string }[] =>
        account.calls.filter((call) => methods.includes(call.method) && !call.path.endsWith("/query"));

    const leaseKeys = (account: ReturnType<typeof fakeAccount>): string[] => [...account.locks.keys()];

    /** Every D1 database but the one the lock table lives in. */
    const previewDatabases = (account: ReturnType<typeof fakeAccount>): string[] => [...account.d1.keys()].filter((name) => name !== "lunora-preview-locks");

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
            const record = JSON.parse(account.kvValues.get(registry)?.get(`${APP_ID}/42`) ?? "{}") as { resources: { kind: string; name: string }[] };

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

            // The lock database and the registry namespace, then the preview's own D1, KV and R2.
            expect(changes(account, "POST")).toHaveLength(5);
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

        it("refuses to deploy over an existing Worker it did not deploy, before creating any resource of the preview's own", async () => {
            expect.assertions(4);

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
            expect(previewDatabases(account)).toStrictEqual([]);
            expect(account.r2.size + account.kv.size - 1).toBe(0);
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
            // Only the shared lock database and the registry: no resource of the preview's own.
            expect(changes(account, "POST", "PUT")).toHaveLength(2);
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
            const current = account.kvValues.get(registry)?.get(`${APP_ID}/42`) ?? "";
            const parsed = JSON.parse(current) as { resources: { kind: string }[] };

            // One read is served a copy written before the R2 bucket was recorded.
            account.staleReads.set(`${APP_ID}/42`, JSON.stringify({ ...parsed, resources: parsed.resources.filter((resource) => resource.kind !== "r2") }));

            const result = await deploy();

            expect(result.error).toMatch(/r2 "lunora-app-preview-42-files" already exist\(s\) but no preview record read/u);
            expect(account.kvValues.get(registry)?.get(`${APP_ID}/42`)).toBe(current);
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
            expect(account.kvValues.get("kv-registry")?.has(`${APP_ID}/42`)).toBe(true);
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

        it("mints an app id into package.json on a local deploy, and a CI run refuses to", async () => {
            expect.assertions(5);

            const account = fakeAccount();
            const { spawner } = wranglerAt(workdir, account.workers);
            const manifest = (): { lunora?: { appId?: string } } =>
                JSON.parse(readFileSync(join(workdir, "package.json"), "utf8")) as { lunora?: { appId?: string } };
            const bare = JSON.stringify({ dependencies: { "@lunora/d1": "*", "@lunora/storage": "*" }, name: "x" });

            writeFileSync(join(workdir, "package.json"), bare, "utf8");

            const ci = await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: { ...CREDENTIALS, CI: "true" },
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(ci.error).toMatch(/a CI run cannot mint one/u);
            expect(manifest().lunora).toBeUndefined();
            expect(account.calls).toHaveLength(0);

            const local = await runPreviewCommand({
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

            const id = manifest().lunora?.appId ?? "";

            expect(local.code).toBe(0);
            expect(registryValues(account).has(`${id}/42`)).toBe(true);
        });

        it("--dry-run names the vars it would set but never prints their values", async () => {
            expect.assertions(4);

            const account = fakeAccount();
            const { infos, logger } = silentLogger();

            const result = await runPreviewCommand({
                cwd: workdir,
                dryRun: true,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                subcommand: "deploy",
                vars: ["WEBHOOK_URL=https://hooks.example/path"],
            });

            const output = infos.join("\n");

            expect(result.code).toBe(0);
            expect(output).not.toContain("hooks.example");
            expect(output).toContain("WEBHOOK_URL");
            expect(output).toContain("PUBLIC_FLAG");
        });

        it("refuses to run beside another preview command in the same checkout, which would restore the config mid-deploy", async () => {
            expect.assertions(3);

            const account = fakeAccount();
            const { logger } = silentLogger();
            const before = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            writeFileSync(join(workdir, ".lunora", "preview.lock"), String(process.pid));

            const result = await runPreviewCommand({
                cwd: workdir,
                dryRun: true,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                subcommand: "deploy",
            });

            expect(result.error).toMatch(/another preview command is running in this checkout/u);
            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(before);
            // The lock belongs to the other command: this one must not remove it on its way out.
            expect(existsSync(join(workdir, ".lunora", "preview.lock"))).toBe(true);
        });

        it("takes over a lock left by a process that is gone, and releases its own", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { logger } = silentLogger();

            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            // Beyond any real pid range, so `process.kill(pid, 0)` reports no such process.
            writeFileSync(join(workdir, ".lunora", "preview.lock"), "2147483646");

            const result = await runPreviewCommand({
                cwd: workdir,
                dryRun: true,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                subcommand: "deploy",
            });

            expect(result.code).toBe(0);
            expect(existsSync(join(workdir, ".lunora", "preview.lock"))).toBe(false);
        });

        it("never overwrites a foreign value that sits at its record key in a namespace carrying the registry's title", async () => {
            expect.assertions(4);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);

            account.kv.set("kv-foreign", "lunora-preview-registry");
            account.kvValues.set("kv-foreign", new Map([[`${APP_ID}/42`, "someone else's data"]]));

            const result = await deployWith(account, spawner);

            expect(result.code).not.toBe(0);
            expect(result.error).toMatch(/reading the preview record/u);
            expect(account.kvValues.get("kv-foreign")?.get(`${APP_ID}/42`)).toBe("someone else's data");
            expect(deploys).toHaveLength(0);
        });

        it("checks the workers.dev subdomain before creating anything, so a refused preview leaves no resources", async () => {
            expect.assertions(4);

            const account = fakeAccount({ noSubdomain: true });
            const { deploys, spawner } = wranglerAt(workdir, account.workers);

            const result = await deployWith(account, spawner);

            expect(result.error).toMatch(/no workers\.dev subdomain/u);
            expect(account.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
            expect(account.d1.size + account.r2.size + account.kv.size).toBe(0);
            expect(deploys).toHaveLength(0);
        });

        /** A second copy of the project, as another checkout or machine would have. */
        const otherCheckout = (): string => {
            const directory = mkdtempSync(join(tmpdir(), "lunora-cli-preview-other-"));

            cpSync(workdir, directory, { recursive: true });

            return directory;
        };

        const deployFrom = async (directory: string, account: ReturnType<typeof fakeAccount>): Promise<Awaited<ReturnType<typeof runPreviewCommand>>> =>
            runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: directory,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner: wranglerAt(directory, account.workers).spawner,
                subcommand: "deploy",
            });

        const raced = async (account: ReturnType<typeof fakeAccount>): Promise<{ held: number; won: number }> => {
            const other = otherCheckout();

            try {
                const results = await Promise.all([deployFrom(workdir, account), deployFrom(other, account)]);

                return {
                    held: results.filter((result) => /another run is deploying or deleting/u.test(result.error ?? "")).length,
                    won: results.filter((result) => result.code === 0).length,
                };
            } finally {
                rmSync(other, { force: true, recursive: true });
            }
        };

        it("never writes to a D1 database named like the lock database that this tooling did not make", async () => {
            expect.assertions(5);

            const account = fakeAccount({ foreignLockDatabase: true });
            const { deploys, spawner } = wranglerAt(workdir, account.workers);

            const result = await deployWith(account, spawner);

            expect(result.error).toMatch(/exists but was not made by lunora preview/u);
            // Looked at, never written to: not a table, not a row.
            expect(account.statements.length).toBeGreaterThan(0);
            expect(account.statements.every((statement) => statement.sql.startsWith("SELECT"))).toBe(true);
            expect(account.locks.size).toBe(0);
            expect(deploys).toHaveLength(0);
        });

        it("marks the lock database it makes, and uses it again on the next run", async () => {
            expect.assertions(3);

            const account = fakeAccount();
            const { spawner } = wranglerAt(workdir, account.workers);

            const first = await deployWith(account, spawner);

            expect(first.code).toBe(0);
            expect(account.statements.some((statement) => statement.sql.startsWith("INSERT INTO lunora_preview_lock_owner"))).toBe(true);

            const again = await deployWith(account, spawner);

            expect(again.code).toBe(0);
        });

        it("keeps a run's hold alive while it works, so a long deploy is never taken over", async () => {
            expect.assertions(4);

            vi.useFakeTimers();

            try {
                const account = fakeAccount();
                const request = async (path: string, init?: RequestInit): ReturnType<typeof cloudflareRestRequest> =>
                    cloudflareRestRequest({ accountId: "acct", apiToken: "token", fetch: account.fetch, init: init ?? {}, path });
                const database = await lockDatabase(request);
                const mine = await takeLease(request, database, APP_ID, "42");
                let lost = false;
                const stop = keepLease(
                    request,
                    database,
                    APP_ID,
                    "42",
                    mine.token ?? "",
                    () => {
                        lost = true;
                    },
                    600_000,
                );

                // Well past the hold's 30 minutes.
                await vi.advanceTimersByTimeAsync(3_000_000);

                const contender = await takeLease(request, database, APP_ID, "42");

                expect(contender.held).toBeDefined();
                expect(lost).toBe(false);

                // Without the renewals the same wait leaves the hold stale, and the next taker has it.
                stop();
                await vi.advanceTimersByTimeAsync(3_000_000);

                const taker = await takeLease(request, database, APP_ID, "42");

                expect(taker.token).toBeDefined();

                // A row that is no longer this run's is reported, not silently kept.
                const stopAgain = keepLease(
                    request,
                    database,
                    APP_ID,
                    "42",
                    "not-the-owner",
                    () => {
                        lost = true;
                    },
                    600_000,
                );

                await vi.advanceTimersByTimeAsync(600_000);
                stopAgain();

                expect(lost).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it("records and migrates against the URL built from the Worker's name, not one printed by wrangler", async () => {
            expect.assertions(4);

            const account = fakeAccount();
            const { spawner: inner } = wranglerAt(workdir, account.workers);
            const noisy: Spawner = async (descriptor) => {
                const outcome = await inner(descriptor);

                return { ...outcome, stdout: outcome.stdout === undefined ? undefined : `docs: https://elsewhere.workers.dev\n${outcome.stdout}` };
            };
            const admin = adminRecorder();
            const result = await runPreviewCommand({
                adminFetch: admin.fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner: noisy,
                subcommand: "deploy",
            });

            expect(result.code).toBe(0);
            // The listed URL is where the migrations went and where a seed would go: the built one.
            expect(result.data?.preview?.url).toBe("https://lunora-app-preview-42.acme.workers.dev");
            expect(admin.calls.length).toBeGreaterThan(0);
            expect(admin.calls.every((call) => call.url.startsWith("https://lunora-app-preview-42.acme.workers.dev"))).toBe(true);
        });

        it("asks whether the Worker is the preview's own once per deploy", async () => {
            expect.assertions(2);

            const account = fakeAccount();
            const { spawner } = wranglerAt(workdir, account.workers);

            const deployed = await deployWith(account, spawner);

            expect(deployed.code).toBe(0);
            expect(account.calls.filter((call) => call.path.endsWith("/workers/scripts/lunora-app-preview-42/settings"))).toHaveLength(1);
        });

        it("puts the config back, removes the secrets file and frees the lock when interrupted mid-deploy", async () => {
            expect.assertions(5);

            const account = fakeAccount();
            const { spawner: inner } = wranglerAt(workdir, account.workers);
            const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
            const saved = (["SIGINT", "SIGTERM"] as const).map((signal) => [signal, process.rawListeners(signal)] as const);
            const seen = { config: "", lock: true, secrets: true };
            const exitCodes: unknown[] = [];
            const interrupted: Spawner = async (descriptor) => {
                if (descriptor.args.includes("deploy") && descriptor.args.includes("--env")) {
                    const secretsPath = descriptor.args[descriptor.args.indexOf("--secrets-file") + 1] ?? "";

                    // Only this command's own handlers hear the signal.
                    for (const [signal, listeners] of saved) {
                        for (const listener of listeners) {
                            process.off(signal, listener);
                        }
                    }

                    process.emit("SIGTERM");
                    seen.config = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");
                    seen.lock = existsSync(join(workdir, ".lunora", "preview.lock"));
                    seen.secrets = existsSync(secretsPath);
                }

                return inner(descriptor);
            };

            try {
                await runPreviewCommand({
                    adminFetch: adminRecorder().fetch,
                    cwd: workdir,
                    environment: CREDENTIALS,
                    fetch: account.fetch,
                    healthFetch: healthy,
                    logger: silentLogger().logger,
                    name: "42",
                    spawner: interrupted,
                    subcommand: "deploy",
                });
            } finally {
                exitCodes.push(...exit.mock.calls.map(([code]) => code));
                exit.mockRestore();

                for (const [signal, listeners] of saved) {
                    for (const listener of listeners) {
                        if (!process.rawListeners(signal).includes(listener)) {
                            process.on(signal, listener);
                        }
                    }
                }
            }

            // Judged at the moment of the interrupt, before any normal cleanup could have run.
            expect(seen.config).toBe(PRODUCTION_WRANGLER);
            expect(seen.lock).toBe(false);
            expect(seen.secrets).toBe(false);
            expect(exitCodes).toContain(143);
            expect(process.listenerCount("SIGTERM")).toBe(saved[1]?.[1].length);
        });

        it("lets exactly one of two runs on different machines take the hold", async () => {
            expect.assertions(2);

            const outcome = await raced(fakeAccount());

            expect(outcome.won).toBe(1);
            expect(outcome.held).toBe(1);
        });

        it("lets exactly one of two runs take over a stale hold", async () => {
            expect.assertions(3);

            const account = fakeAccount();

            account.locks.set(`${APP_ID}/42`, { expires: 1, owner: "crashed" });

            const outcome = await raced(account);

            expect(outcome.won).toBe(1);
            expect(outcome.held).toBe(1);
            expect(leaseKeys(account)).toStrictEqual([]);
        });

        it("lets a run that does not own the hold neither release nor steal it", async () => {
            expect.assertions(3);

            const account = fakeAccount();
            const request = async (path: string, init?: RequestInit): ReturnType<typeof cloudflareRestRequest> =>
                cloudflareRestRequest({ accountId: "acct", apiToken: "token", fetch: account.fetch, init: init ?? {}, path });
            const database = await lockDatabase(request);
            const mine = await takeLease(request, database, APP_ID, "42");

            await releaseLease(request, database, APP_ID, "42", "not-the-owner");

            expect(account.locks.get(`${APP_ID}/42`)?.owner).toBe(mine.token);

            const contender = await takeLease(request, database, APP_ID, "42");

            expect(contender.held).toBeDefined();

            await releaseLease(request, database, APP_ID, "42", mine.token ?? "");

            expect(leaseKeys(account)).toStrictEqual([]);
        });

        it.each([
            ["taking the hold fails", (sql: string) => sql.startsWith("INSERT")],
            ["reading a held row fails", (sql: string) => sql.startsWith("SELECT")],
            ["taking over a stale row fails", (sql: string) => sql.startsWith("UPDATE")],
        ])("refuses, and creates nothing, when %s with anything but a definite conflict", async (_label, failing) => {
            expect.assertions(4);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);

            account.locks.set(`${APP_ID}/42`, { expires: 1, owner: "crashed" });

            const broken = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const { sql } = (input as string).endsWith("/query") ? (JSON.parse(init?.body as string) as { sql: string }) : { sql: "" };

                return failing(sql) ? new Response("{}", { status: 403 }) : account.fetch(input, init);
            }) as typeof globalThis.fetch;

            const result = await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: broken,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(result.code).not.toBe(0);
            expect(deploys).toHaveLength(0);
            expect(previewDatabases(account)).toStrictEqual([]);
            expect(account.locks.get(`${APP_ID}/42`)?.owner).toBe("crashed");
        });

        it("refuses to deploy while another run holds the preview, and releases the hold when done", async () => {
            expect.assertions(5);

            const account = fakeAccount();
            const { spawner } = wranglerAt(workdir, account.workers);
            const first = await deployWith(account, spawner);

            expect(first.code).toBe(0);
            // Done: nothing is held, so a second deploy goes through.
            expect(leaseKeys(account)).toStrictEqual([]);

            account.locks.set(`${APP_ID}/42`, { expires: Math.floor(Date.now() / 1000) + 600, owner: "someone-else" });

            const blocked = await deployWith(account, spawner);

            expect(blocked.error).toMatch(/another run is deploying or deleting preview "42"/u);
            expect(account.locks.get(`${APP_ID}/42`)?.owner).toBe("someone-else");

            account.locks.delete(`${APP_ID}/42`);

            const again = await deployWith(account, spawner);

            expect(again.code).toBe(0);
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

        const run = async (
            account: ReturnType<typeof fakeAccount>,
            subcommand: "delete" | "deploy" | "list",
            extra: { environment?: Record<string, string>; spawner?: Spawner } = {},
        ): Promise<{ result: Awaited<ReturnType<typeof runPreviewCommand>>; warns: string[] }> => {
            const { logger, warns } = silentLogger();
            const result = await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: extra.environment ?? CREDENTIALS,
                fetch: account.fetch,
                healthFetch: healthy,
                logger,
                name: "42",
                subcommand,
                ...(extra.spawner === undefined ? {} : { spawner: extra.spawner }),
            });

            return { result, warns };
        };

        const setAppId = (id: string | undefined): void => {
            writeFileSync(
                join(workdir, "package.json"),
                JSON.stringify({
                    dependencies: { "@lunora/d1": "*", "@lunora/storage": "*" },
                    ...(id === undefined ? {} : { lunora: { appId: id } }),
                    name: "x",
                }),
                "utf8",
            );
        };

        it("still finds and tears down a preview after the Worker was renamed", async () => {
            expect.assertions(6);

            const account = await deployed();

            writeFileSync(join(workdir, "wrangler.jsonc"), PRODUCTION_WRANGLER.replace('"name": "lunora-app",', '"name": "lunora-renamed",'), "utf8");

            const listed = await run(account, "list");

            expect(listed.result.data?.previews?.map((preview) => preview.name)).toStrictEqual(["42"]);

            const { result } = await run(account, "delete");

            expect(result.code).toBe(0);
            expect(account.workers.has("lunora-app-preview-42")).toBe(false);
            expect(previewDatabases(account).length + account.kv.size - 1 + account.r2.size).toBe(0);
            expect(registryValues(account).size).toBe(0);

            const again = await run(account, "delete");

            expect(again.result.code).toBe(EXIT_CODE.NOT_FOUND);
        });

        it("keeps two apps with the same Worker name in one account apart", async () => {
            expect.assertions(9);

            const account = await deployed();
            const other = "0a1b2c3d-1111-4222-8333-444455556666";

            setAppId(other);

            const foreign = await run(account, "list");

            expect(foreign.result.data?.previews).toHaveLength(0);

            const removal = await run(account, "delete");

            // Not "nothing to delete": the Worker is there, only another app's record names it.
            expect(removal.result.code).toBe(EXIT_CODE.FAILURE);
            expect(removal.result.error).toMatch(/Worker "lunora-app-preview-42" exists/u);
            expect(account.workers.has("lunora-app-preview-42")).toBe(true);

            // The other app's deploy meets a Worker and resources it has no record of: it takes none of them.
            const { spawner } = wranglerAt(workdir, account.workers);
            const deploy = await run(account, "deploy", { spawner });

            expect(deploy.result.error).toMatch(/no preview record says this preview deployed it/u);
            expect(registryValues(account).has(`${other}/42`)).toBe(false);

            setAppId(APP_ID);

            const own = await run(account, "list");
            const removed = await run(account, "delete");

            expect(own.result.data?.previews).toHaveLength(1);
            expect(removed.result.code).toBe(0);
            expect(account.workers.has("lunora-app-preview-42")).toBe(false);
        });

        it("removes a resource whose create succeeded but whose confirming record write failed, because the record named it first", async () => {
            expect.assertions(6);

            const account = fakeAccount();
            const { deploys, spawner } = wranglerAt(workdir, account.workers);
            let writes = 0;
            const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
                if (init?.method === "PUT" && (input as string).includes(encodeURIComponent(`${APP_ID}/42`))) {
                    writes += 1;

                    // 1: the empty record, 2: the claim on the first resource, 3: its confirmation.
                    if (writes === 3) {
                        return new Response("{}", { status: 403 });
                    }
                }

                return account.fetch(input, init);
            }) as typeof globalThis.fetch;

            const failed = await runPreviewCommand({
                adminFetch: adminRecorder().fetch,
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: flaky,
                healthFetch: healthy,
                logger: silentLogger().logger,
                name: "42",
                spawner,
                subcommand: "deploy",
            });

            expect(failed.code).not.toBe(0);
            expect(deploys).toHaveLength(0);
            // Created in the account, but the record only has the claim.
            expect(previewDatabases(account).length + account.r2.size + account.kv.size - 1).toBeGreaterThan(0);

            const { result } = await run(account, "delete");

            expect(result.code).toBe(0);
            expect(previewDatabases(account).length + account.r2.size + account.kv.size - 1).toBe(0);
            expect(registryValues(account).has(`${APP_ID}/42`)).toBe(false);
        });

        it("never lets an object key steer a delete out of the preview's bucket", async () => {
            expect.assertions(4);

            const account = await deployed();

            // Production's database, and an object whose key climbs out of the bucket's path to name it.
            account.d1.set("prod-db", "prod-d1-uuid");
            account.r2Objects.set("lunora-app-preview-42-files", new Set(["../../../../d1/database/prod-d1-uuid"]));
            account.calls.length = 0;

            const { result } = await run(account, "delete");

            expect(result.error).toMatch(/could not be deleted|"\.\." segment/u);
            expect(account.d1.has("prod-db")).toBe(true);
            expect(account.calls.filter((call) => call.method === "DELETE" && call.path.includes("prod-d1-uuid"))).toHaveLength(0);
            // The bucket, which still holds the object, stays on record for a person to clear.
            expect(registryValues(account).has(`${APP_ID}/42`)).toBe(true);
        });

        it("empties a bucket of any size, not just the first fifty rounds of it", async () => {
            expect.assertions(2);

            const account = await deployed();

            account.r2Objects.set("lunora-app-preview-42-files", new Set(Array.from({ length: 130 }, (_value, index) => `uploads/${String(index)}.png`)));

            const { result } = await run(account, "delete");

            expect(result.code).toBe(0);
            expect(account.r2.size).toBe(0);
        });

        it("refuses to delete while another run holds the preview, deleting nothing", async () => {
            expect.assertions(3);

            const account = await deployed();

            account.locks.set(`${APP_ID}/42`, { expires: Math.floor(Date.now() / 1000) + 600, owner: "someone-else" });

            const { result } = await run(account, "delete");

            expect(result.error).toMatch(/another run is deploying or deleting preview "42"/u);
            expect(account.workers.has("lunora-app-preview-42")).toBe(true);
            expect(registryValues(account).has(`${APP_ID}/42`)).toBe(true);
        });

        it("takes over a hold older than its lifetime, and leaves none behind", async () => {
            expect.assertions(2);

            const account = await deployed();

            account.locks.set(`${APP_ID}/42`, { expires: 1, owner: "crashed" });

            const { result } = await run(account, "delete");

            expect(result.code).toBe(0);
            expect(leaseKeys(account)).toStrictEqual([]);
        });

        it("a delete --dry-run on a record from before app ids changes nothing in the account", async () => {
            expect.assertions(3);

            const account = await deployed();
            const values = registryValues(account);
            const record = JSON.parse(values.get(`${APP_ID}/42`) ?? "{}") as Record<string, unknown>;

            delete record.appId;
            values.delete(`${APP_ID}/42`);
            values.set("lunora-app/42", JSON.stringify(record));
            account.calls.length = 0;

            const { logger } = silentLogger();
            const result = await runPreviewCommand({
                cwd: workdir,
                dryRun: true,
                environment: CREDENTIALS,
                fetch: account.fetch,
                logger,
                name: "42",
                subcommand: "delete",
            });

            expect(result.code).toBe(0);
            expect(account.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
            expect(values.has("lunora-app/42")).toBe(true);
        });

        it("does not report a preview as absent when its Worker still exists but no record is read", async () => {
            expect.assertions(3);

            const account = await deployed();

            // A record this location has not seen yet, or one filed under another app id: the Worker is still there.
            registryValues(account).delete(`${APP_ID}/42`);

            const { result } = await run(account, "delete");

            expect(result.code).toBe(EXIT_CODE.FAILURE);
            expect(result.error).toMatch(/Worker "lunora-app-preview-42" exists/u);
            expect(account.workers.has("lunora-app-preview-42")).toBe(true);
        });

        describe("a preview recorded before projects had an id", () => {
            const toLegacy = (account: ReturnType<typeof fakeAccount>): void => {
                const values = registryValues(account);
                const record = JSON.parse(values.get(`${APP_ID}/42`) ?? "{}") as Record<string, unknown>;

                delete record.appId;
                values.delete(`${APP_ID}/42`);
                values.set("lunora-app/42", JSON.stringify(record));
            };

            it("is re-keyed under the id on delete, reported, and torn down", async () => {
                expect.assertions(5);

                const account = await deployed();

                toLegacy(account);

                const { result, warns } = await run(account, "delete");

                expect(result.code).toBe(0);
                expect(warns.join("\n")).toMatch(/recorded under the Worker name "lunora-app"; it is now recorded under project/u);
                expect(registryValues(account).size).toBe(0);
                expect(account.workers.has("lunora-app-preview-42")).toBe(false);
                expect(account.r2.size).toBe(0);
            });

            it("is listed with a note, and re-keyed by the next deploy", async () => {
                expect.assertions(4);

                const account = await deployed();

                toLegacy(account);

                const listed = await run(account, "list");

                expect(listed.result.data?.previews?.map((preview) => preview.name)).toStrictEqual(["42"]);
                expect(listed.warns.join("\n")).toMatch(/1 preview\(s\) are recorded under the Worker name/u);

                const { spawner } = wranglerAt(workdir, account.workers);
                const redeploy = await run(account, "deploy", { spawner });

                expect(redeploy.result.code).toBe(0);
                expect([...registryValues(account).keys()]).toStrictEqual([`${APP_ID}/42`]);
            });

            it("is refused with an instruction, deleting nothing, when the project has no id yet", async () => {
                expect.assertions(4);

                const account = await deployed();

                toLegacy(account);
                setAppId(undefined);

                const { result } = await run(account, "delete");

                expect(result.code).not.toBe(0);
                expect(result.error).toMatch(/Add an app id to package\.json/u);
                expect(account.workers.has("lunora-app-preview-42")).toBe(true);
                expect(registryValues(account).has("lunora-app/42")).toBe(true);
            });

            it("is refused when the old-key record is not the one this CLI would have written", async () => {
                expect.assertions(3);

                const account = await deployed();

                toLegacy(account);

                const values = registryValues(account);
                const record = JSON.parse(values.get("lunora-app/42") ?? "{}") as Record<string, unknown>;

                values.set("lunora-app/42", JSON.stringify({ ...record, resources: [], worker: "billing-prod" }));

                const { result } = await run(account, "delete");

                expect(result.error).toMatch(/is not the one this CLI wrote for that Worker and preview/u);
                expect(account.workers.has("lunora-app-preview-42")).toBe(true);
                expect(registryValues(account).has("lunora-app/42")).toBe(true);
            });
        });

        it("deletes the Worker and every recorded resource, then the record; list no longer shows it", async () => {
            expect.assertions(6);

            const account = await deployed();
            const { logger } = silentLogger();

            const result = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, name: "42", subcommand: "delete" });

            expect(result.code).toBe(0);
            expect(account.workers.size).toBe(0);
            expect(previewDatabases(account)).toStrictEqual([]);
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
            expect(changes(account, "DELETE")).toHaveLength(0);
        });

        it("refuses a record that names a production resource, and deletes nothing", async () => {
            expect.assertions(2);

            const account = await deployed();
            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const values = account.kvValues.get(registry);
            const record = JSON.parse(values?.get(`${APP_ID}/42`) ?? "{}") as { resources: { id: string; kind: string }[] };

            record.resources = record.resources.map((resource) => (resource.kind === "d1" ? { ...resource, id: "prod-d1-uuid" } : resource));
            values?.set(`${APP_ID}/42`, JSON.stringify(record));
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
            expect(changes(account, "DELETE")).toHaveLength(0);
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
            expect(changes(account, "DELETE")).toHaveLength(0);
            expect(account.workers.has("lunora-app-preview-42")).toBe(true);
        });

        const recordOf = (
            account: ReturnType<typeof fakeAccount>,
        ): { set: (record: unknown) => void; value: Record<string, unknown> & { resources: Record<string, string>[] } } => {
            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const values = account.kvValues.get(registry);

            return {
                set: (record) => values?.set(`${APP_ID}/42`, JSON.stringify(record)),
                value: JSON.parse(values?.get(`${APP_ID}/42`) ?? "{}") as Record<string, unknown> & { resources: Record<string, string>[] },
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
            expect(changes(account, "DELETE")).toHaveLength(0);
            expect(account.d1.has("billing-db")).toBe(true);
        });

        it("refuses a record that names another preview, whose registry key it would otherwise delete", async () => {
            expect.assertions(2);

            const account = await deployed();
            const record = recordOf(account);

            record.set({ ...record.value, name: "7" });
            // The Worker is already gone, so its marker cannot catch the mismatch.
            account.workers.clear();
            account.kvValues.get([...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "")?.set(`${APP_ID}/7`, "{}");
            account.calls.length = 0;

            const result = await deleteIt(account);

            expect(result.error).toMatch(/refusing to delete anything/u);
            expect(changes(account, "DELETE")).toHaveLength(0);
        });

        it("exits 1, never the not-on-record code, when a Cloudflare call fails mid-delete (the CI teardown tolerates only the latter)", async () => {
            expect.assertions(3);

            const account = await deployed();
            const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const { pathname } = new URL(input as string);

                if (init?.method === "DELETE" && pathname.includes("/d1/")) {
                    return Response.json({ errors: [{ code: 7003, message: "not found" }], success: false }, { status: 404 });
                }

                if (init?.method === "DELETE" && pathname.includes("/storage/kv/")) {
                    return new Response("{}", { status: 403 });
                }

                return account.fetch(input, init);
            }) as typeof globalThis.fetch;

            const result = await runPreviewCommand({
                cwd: workdir,
                environment: CREDENTIALS,
                fetch: failing,
                logger: silentLogger().logger,
                name: "42",
                subcommand: "delete",
            });

            expect(result.code).toBe(EXIT_CODE.FAILURE);
            expect(result.code).not.toBe(EXIT_CODE.NOT_FOUND);
            expect(result.error).toMatch(/could not be deleted/u);
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
            expect(changes(account, "DELETE")).toHaveLength(0);
        });

        it("leaves the newer record alone when a stale read of it misses a resource, so a re-run deletes everything", async () => {
            expect.assertions(6);

            const account = await deployed();
            const record = recordOf(account);

            // One read is served a copy written before the R2 bucket was added to the record.
            account.staleReads.set(
                `${APP_ID}/42`,
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

            account.kvValues.get(registry)?.set(`${APP_ID}/hand-edited`, JSON.stringify({ version: 1 }));

            const { logger, warns } = silentLogger();
            const listed = await runPreviewCommand({ cwd: workdir, environment: CREDENTIALS, fetch: account.fetch, logger, subcommand: "list" });

            expect(listed.code).toBe(0);
            expect(listed.data?.previews?.map((preview) => preview.name)).toStrictEqual(["42"]);
            expect(warns.join("\n")).toContain(`"${APP_ID}/hand-edited" is not a preview record`);
        });

        it("lists every recorded preview across pages of the registry's keys", async () => {
            expect.assertions(1);

            const account = await deployed();
            const registry = [...account.kv].find(([, title]) => title === "lunora-preview-registry")?.[0] ?? "";
            const values = account.kvValues.get(registry);
            const template = JSON.parse(values?.get(`${APP_ID}/42`) ?? "{}") as Record<string, unknown>;

            // Records written straight into the registry: deploying each one would only make the test slow.
            for (const name of ["1", "2", "3", "4"]) {
                values?.set(`${APP_ID}/${name}`, JSON.stringify({ ...template, name, resources: [], worker: `lunora-app-preview-${name}` }));
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
            expect(changes(account, "DELETE")).toHaveLength(0);
        });
    });
});
