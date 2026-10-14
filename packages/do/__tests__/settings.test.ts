import { ADMIN_FUNCTIONS, buildSettings, isDevEnvironment } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

const ADMIN_TOKEN = "s3cret-admin";

/** A ShardDO whose `handleRpc` throws — the admin branch must short-circuit first. */
class AdminShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override async handleRpc(): Promise<unknown> {
        throw new Error("handleRpc must not run for admin RPCs");
    }
}

const adminRequest = (functionPath: string, args: Record<string, unknown>, token?: string): Request => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }

    return new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers,
        method: "POST",
    });
};

describe("buildSettings masking", () => {
    it("masks string vars and secrets, never returning the raw value", () => {
        expect.assertions(5);

        // eslint-disable-next-line no-secrets/no-secrets -- fake high-entropy value to prove it's never returned raw
        const secretValue = "sk_live_abcdef0123456789"; // gitleaks:allow
        const result = buildSettings({ API_KEY: secretValue, GREETING: "hello-world" });

        const apiKey = result.settings.find((entry) => entry.name === "API_KEY");
        const greeting = result.settings.find((entry) => entry.name === "GREETING");

        expect(apiKey?.kind).toBe("secret");
        // The raw secret never appears in any field of the result.
        expect(JSON.stringify(result)).not.toContain(secretValue);
        expect(apiKey?.value).not.toBe(secretValue);
        // Masked preview keeps a recognisable prefix only.
        expect(apiKey?.value?.startsWith("sk_l")).toBe(true);
        expect(greeting?.kind).toBe("var");
    });

    it("classifies non-string bindings by kind with no value, and skips lunora internal vars", () => {
        expect.assertions(4);

        const r2Bucket = { delete() {}, get() {}, head() {}, list() {}, put() {} };
        const doNamespace = { get() {}, idFromName() {}, idFromString() {} };

        const result = buildSettings({
            LUNORA_ADMIN_TOKEN: "should-be-hidden",
            MY_BUCKET: r2Bucket,
            SHARD: doNamespace,
        });

        const bucket = result.settings.find((entry) => entry.name === "MY_BUCKET");
        const shard = result.settings.find((entry) => entry.name === "SHARD");

        expect(bucket).toEqual({ bindingType: "r2", kind: "binding", name: "MY_BUCKET", value: null });
        expect(shard?.bindingType).toBe("durable-object");
        // The reserved admin token is omitted from the view entirely.
        expect(result.settings.some((entry) => entry.name === "LUNORA_ADMIN_TOKEN")).toBe(false);
        expect(result.settings.every((entry) => entry.kind !== "secret" || typeof entry.value === "string")).toBe(true);
    });

    it("reads best-effort deploy info from well-known vars and version metadata", () => {
        expect.assertions(3);

        const result = buildSettings({
            CF_VERSION_METADATA: { id: "ver-123", tag: "v9", timestamp: 0 },
            ENVIRONMENT: "production",
            WORKER_URL: "https://app.example.workers.dev",
        });

        expect(result.deploy.workerUrl).toBe("https://app.example.workers.dev");
        expect(result.deploy.environment).toBe("production");
        expect(result.deploy.deploymentId).toBe("ver-123");
    });

    it("omits deploy fields that aren't reachable from env", () => {
        expect.assertions(1);

        const result = buildSettings({ GREETING: "hi" });

        expect(result.deploy).toEqual({});
    });
});

describe("getSettings admin RPC", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    it("returns the masked deployment config, never the raw secret", async () => {
        expect.assertions(4);

        const secretValue = "tok_supersecretvalue";
        const shard = new AdminShard(state, { API_TOKEN: secretValue, LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, GREETING: "hi" });

        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getSettings, {}, ADMIN_TOKEN));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: { settings: { kind: string; name: string }[] } }>();
        const raw = JSON.stringify(body);

        // The secret value never crosses the wire.
        expect(raw).not.toContain(secretValue);

        const token = body.result.settings.find((entry) => entry.name === "API_TOKEN");

        expect(token?.kind).toBe("secret");
        // The reserved admin token is not surfaced.
        expect(body.result.settings.some((entry) => entry.name === "LUNORA_ADMIN_TOKEN")).toBe(false);
    });

    it("is gated by the admin bearer like the sibling read-only RPCs", async () => {
        expect.assertions(2);

        const shard = new AdminShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN, GREETING: "hi" });

        const missing = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getSettings, {}));
        const wrong = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.getSettings, {}, "nope"));

        expect(missing.status).toBe(403);
        expect(wrong.status).toBe(403);
    });
});

describe("isDevEnvironment", () => {
    it("is true for dev-like environment names across the recognised vars", () => {
        expect.assertions(5);

        expect(isDevEnvironment({ NODE_ENV: "development" })).toBe(true);
        expect(isDevEnvironment({ ENVIRONMENT: "dev" })).toBe(true);
        expect(isDevEnvironment({ WORKER_ENV: "local" })).toBe(true);
        expect(isDevEnvironment({ CF_ENV: "test" })).toBe(true);
        expect(isDevEnvironment({ NODE_ENV: "LOCALHOST" })).toBe(true);
    });

    it("is false for production and when no environment var is set (production-safe default)", () => {
        expect.assertions(4);

        expect(isDevEnvironment({ NODE_ENV: "production" })).toBe(false);
        expect(isDevEnvironment({ ENVIRONMENT: "staging" })).toBe(false);
        expect(isDevEnvironment({})).toBe(false);
        expect(isDevEnvironment(undefined)).toBe(false);
    });
});
