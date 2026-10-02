import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServiceBindingIR } from "@lunora/codegen";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileWranglerBindings } from "../src/cloudflare/reconcile-bindings";
import type { InferredBindings } from "../src/infer-bindings";

const inferred = (services: ServiceBindingIR[] | undefined): InferredBindings => {
    return {
        agents: [],
        containers: [],
        durableObjects: [{ binding: "SHARD", className: "ShardDO" }],
        needsD1: false,
        queues: [],
        services,
        signals: [],
        usesAi: false,
        usesAnalytics: false,
        usesAuth: false,
        usesBrowser: false,
        usesFlags: false,
        usesHyperdrive: false,
        usesImages: false,
        usesKv: false,
        usesMail: false,
        usesNotify: false,
        usesPayment: false,
        usesPipelines: false,
        usesR2sql: false,
        usesScheduler: false,
        usesStorage: false,
        usesWorkerLoader: false,
        usesX402Charge: false,
        usesX402Pay: false,
        workflows: [],
    };
};

describe("reconcileServices", () => {
    let root: string;
    let parser: ServiceBindingIR;
    let gateway: ServiceBindingIR;

    const config = (): Record<string, any> => parseJsonc(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as Record<string, any>;
    const lunora = (): unknown => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { lunora?: unknown }).lunora;

    const service = (name: string, worker: string, envWorkers: Record<string, string> = {}, entrypoint?: string): ServiceBindingIR => {
        return {
            binding: `SERVICE_${name.toUpperCase()}`,
            ...(entrypoint === undefined ? {} : { entrypoint }),
            envWorkers,
            main: join(root, "services", name, "src/index.ts"),
            name,
            publicScopes: [],
            rpc: entrypoint !== undefined,
            worker,
            wranglerPath: join(root, "services", name, "wrangler.jsonc"),
        };
    };

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-reconcile-services-"));
        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{
    "name": "app",
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "observability": { "enabled": true },
    "services": [{ "binding": "LEGACY", "service": "legacy-worker" }],
    "env": { "production": {} },
}
`,
            "utf8",
        );
        writeFileSync(join(root, "package.json"), `{ "name": "app" }\n`, "utf8");
        parser = service("parser", "neore-parser");
        gateway = service("gateway", "neore-gateway", { production: "gateway-prod" }, "Gateway");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("writes each declared service at the top level and per env, beside a hand-written entry", () => {
        expect.assertions(3);

        reconcileWranglerBindings(root, inferred([gateway, parser]));

        expect(config()["services"]).toStrictEqual([
            { binding: "LEGACY", service: "legacy-worker" },
            { binding: "SERVICE_GATEWAY", entrypoint: "Gateway", service: "neore-gateway" },
            { binding: "SERVICE_PARSER", service: "neore-parser" },
        ]);
        // The service's own env name wins; otherwise wrangler's `<name>-<env>`.
        expect(config()["env"].production.services).toStrictEqual([
            { binding: "SERVICE_GATEWAY", entrypoint: "Gateway", service: "gateway-prod" },
            { binding: "SERVICE_PARSER", service: "neore-parser-production" },
        ]);
        expect(lunora()).toStrictEqual({
            services: { "env.production.services": ["SERVICE_GATEWAY", "SERVICE_PARSER"], services: ["SERVICE_GATEWAY", "SERVICE_PARSER"] },
        });
    });

    it("is idempotent, and removes an owned entry once its declaration goes", () => {
        expect.assertions(3);

        reconcileWranglerBindings(root, inferred([gateway, parser]));

        expect(reconcileWranglerBindings(root, inferred([gateway, parser])).changed).toBe(false);

        reconcileWranglerBindings(root, inferred([parser]));

        expect(config()["services"]).toStrictEqual([
            { binding: "LEGACY", service: "legacy-worker" },
            { binding: "SERVICE_PARSER", service: "neore-parser" },
        ]);

        reconcileWranglerBindings(root, inferred([]));

        expect(lunora()).toBeUndefined();
    });

    it("leaves a hand-written entry holding a declared binding alone, and says so", () => {
        expect.assertions(2);

        writeFileSync(
            join(root, "wrangler.jsonc"),
            `{ "name": "app", "observability": { "enabled": true }, "services": [{ "binding": "SERVICE_PARSER", "service": "elsewhere" }] }\n`,
            "utf8",
        );

        const result = reconcileWranglerBindings(root, inferred([parser]));

        expect(config()["services"]).toStrictEqual([{ binding: "SERVICE_PARSER", service: "elsewhere" }]);
        expect(result.warnings).toContainEqual(expect.stringContaining(`hand-written "SERVICE_PARSER"`));
    });

    it("leaves every entry alone when the declaration is unreadable", () => {
        expect.assertions(2);

        reconcileWranglerBindings(root, inferred([gateway, parser]));

        const before = readFileSync(join(root, "wrangler.jsonc"), "utf8");

        reconcileWranglerBindings(root, inferred(undefined));

        expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).toBe(before);
        expect(lunora()).toStrictEqual(expect.objectContaining({ services: expect.any(Object) }));
    });

    it("keeps both records when queue tuning and services are recorded in one pass", () => {
        expect.assertions(1);

        const receipt = { bindingName: "QUEUE_RECEIPT", exportName: "receiptQueue", mode: "push" as const, name: "receipt-queue", tuning: { maxRetries: 5 } };

        reconcileWranglerBindings(root, { ...inferred([parser]), queues: [receipt] });

        expect(Object.keys(lunora() as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["queueTuning", "services"]);
    });

    it("writes the bindings into the SvelteKit / Nuxt dev sidecar's wrangler.dev.jsonc too, and removes them with the declaration", () => {
        expect.assertions(3);

        writeFileSync(join(root, "wrangler.dev.jsonc"), `{ "name": "app-dev", "main": "lunora/server.ts" }\n`, "utf8");

        reconcileWranglerBindings(root, inferred([parser]));

        const devConfig = (): Record<string, any> => parseJsonc(readFileSync(join(root, "wrangler.dev.jsonc"), "utf8")) as Record<string, any>;

        expect(devConfig()["services"]).toStrictEqual([{ binding: "SERVICE_PARSER", service: "neore-parser" }]);
        expect((lunora() as { services: Record<string, unknown> }).services["dev:services"]).toStrictEqual(["SERVICE_PARSER"]);

        reconcileWranglerBindings(root, inferred([]));

        expect(devConfig()["services"]).toBeUndefined();
    });

    it("keeps the dev sidecar's ownership while wrangler.dev.jsonc cannot be read", () => {
        expect.assertions(1);

        writeFileSync(join(root, "wrangler.dev.jsonc"), `{ "name": "app-dev", "main": "lunora/server.ts" }\n`, "utf8");
        reconcileWranglerBindings(root, inferred([parser]));
        writeFileSync(join(root, "wrangler.dev.jsonc"), `{ "name": `, "utf8");
        reconcileWranglerBindings(root, inferred([parser]));

        expect((lunora() as { services: Record<string, unknown> }).services["dev:services"]).toStrictEqual(["SERVICE_PARSER"]);
    });
});
