import type { WranglerConfigShape } from "@lunora/config/cloudflare";
import { describe, expect, it } from "vitest";

import type { EjectPorts } from "../src/util/eject";
import { byoConfig, runEject } from "../src/util/eject";

/** `lunora cloud eject` — the no-lock-in exit hatch (GAPS.md D2). */

const target = {
    projectSlug: "acme-app",
    scriptName: "acme-app-v3",
    url: "https://acme-app.lunora.app",
};

/** A project that binds more than the old hard-coded template knew about. */
const PROJECT: Record<string, unknown> & WranglerConfigShape = {
    account_id: "old-account",
    assets: { binding: "ASSETS", directory: "./dist/client" },
    compatibility_date: "2026-06-10",
    d1_databases: [{ binding: "GLOBAL_DB", database_id: "d1-old", database_name: "acme-db" }],
    durable_objects: { bindings: [{ class_name: "ShardDO", name: "SHARD" }] },
    env: { staging: { kv_namespaces: [{ binding: "CACHE", id: "kv-staging" }] } },
    kv_namespaces: [{ binding: "CACHE", id: "kv-old" }],
    main: "src/worker.ts",
    migrations: [{ new_sqlite_classes: ["ShardDO"], tag: "v1" }],
    name: "acme-local",
    queues: { consumers: [{ queue: "jobs" }], producers: [{ binding: "JOBS", queue: "jobs" }] },
    r2_buckets: [{ binding: "UPLOADS", bucket_name: "acme-uploads" }],
    services: [{ binding: "AUTH", service: "auth-worker" }],
};

const fakePorts = (written: Map<string, string>, over: Partial<EjectPorts> = {}): EjectPorts => {
    return {
        fetchPackage: () => Promise.resolve({ ...target, snapshot: '{"table":"users","row":{}}\n' }),
        outputDirectory: "eject",
        project: { config: PROJECT, configDirectory: ".." },
        writeFile: (name, content) => {
            written.set(name, content);

            return Promise.resolve();
        },
        ...over,
    };
};

describe(byoConfig, () => {
    it("keeps every binding the project has and replaces the old account's ids with create commands", () => {
        expect.assertions(6);

        const config = byoConfig(PROJECT, target) as Record<string, unknown>;

        expect(config["name"]).toBe("acme-app-v3");
        expect(config["account_id"]).toBeUndefined();
        expect(config["d1_databases"]).toStrictEqual([
            { binding: "GLOBAL_DB", database_id: "<create with: wrangler d1 create acme-db>", database_name: "acme-db" },
        ]);
        expect(config["kv_namespaces"]).toStrictEqual([{ binding: "CACHE", id: "<create with: wrangler kv namespace create CACHE>" }]);
        // A wrangler environment names resources in the old account just the same.
        expect(JSON.stringify(config["env"])).not.toContain("kv-staging");
        expect(config["r2_buckets"]).toStrictEqual(PROJECT.r2_buckets);
    });

    it("does not mutate the project's config", () => {
        expect.assertions(1);

        byoConfig(PROJECT, target);

        expect(PROJECT.kv_namespaces?.[0]?.id).toBe("kv-old");
    });
});

describe(runEject, () => {
    it("writes the snapshot, the BYO config, the Alchemy program and the README", async () => {
        expect.assertions(8);

        const written = new Map<string, string>();
        const result = await runEject(fakePorts(written));

        expect(result.files).toStrictEqual(["export.ndjson", "wrangler.jsonc", "alchemy.run.ts", "README.md"]);
        expect(written.get("export.ndjson")).toContain('"table":"users"');

        const wrangler = JSON.parse(written.get("wrangler.jsonc") ?? "") as WranglerConfigShape;

        // The file moved into ./eject, so its relative paths are rebased onto the project.
        expect([wrangler.main, wrangler.assets?.directory]).toStrictEqual(["../src/worker.ts", "../dist/client"]);

        const program = written.get("alchemy.run.ts") ?? "";

        // eslint-disable-next-line no-secrets/no-secrets -- emitted Alchemy source, not a credential
        expect(program).toContain(`Cloudflare.R2.Bucket("UPLOADS", { name: "acme-uploads" })`);
        expect(program).toContain(`Cloudflare.Queues.Consumer("jobs-consumer"`);
        // Alchemy runs from the project directory, so the program keeps the config's own paths.
        expect(program).toContain(`main: "src/worker.ts",`);

        const readme = written.get("README.md") ?? "";

        expect(readme).toContain("wrangler r2 bucket create acme-uploads");
        expect(readme).toContain("https://acme-app.lunora.app");
    });

    it("reports what the Alchemy program cannot carry, in the result and the README", async () => {
        expect.assertions(2);

        const written = new Map<string, string>();
        const result = await runEject(fakePorts(written));

        expect(result.unsupported).toStrictEqual(["env", "services"]);
        expect(written.get("README.md")).toContain("- services");
    });

    /**
     * A half-written eject directory is worse than none: it looks like a backup
     * and is not one. The fetch therefore has to complete before the first write.
     */
    it("writes nothing when the export fails", async () => {
        expect.assertions(2);

        const written = new Map<string, string>();

        await expect(runEject(fakePorts(written, { fetchPackage: () => Promise.reject(new Error("export failed")) }))).rejects.toThrow("export failed");
        expect(written.size).toBe(0);
    });
});
