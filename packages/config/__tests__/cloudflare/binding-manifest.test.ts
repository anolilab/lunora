import { describe, expect, it } from "vitest";

import type { ManifestConfigShape } from "../../src/cloudflare/binding-manifest";
import { BINDING_MANIFEST_VERSION, buildBindingManifest } from "../../src/cloudflare/binding-manifest";

describe("buildBindingManifest", () => {
    it("carries every binding section, including the ones lunora cannot provision", () => {
        expect.assertions(2);

        // KV / Hyperdrive / Vectorize ids are exactly what Lunora warns about and
        // never writes, because it cannot mint them — so they are exactly what an
        // external deployer needs listed. Dropping them would leave out the half
        // the consumer of this manifest most needs.
        const manifest = buildBindingManifest({
            d1_databases: [{ binding: "DB", database_id: "d1-id", database_name: "app" }],
            hyperdrive: [{ binding: "SQL", id: "hd-id" }],
            kv_namespaces: [{ binding: "CACHE", id: "kv-id" }],
            r2_buckets: [{ binding: "FILES", bucket_name: "app-files" }],
            vectorize: [{ binding: "VECTORS", index_name: "app-index" }],
        });

        expect(manifest.bindings).toStrictEqual([
            { binding: "DB", resource: "app", resourceId: "d1-id", type: "d1" },
            { binding: "SQL", resourceId: "hd-id", type: "hyperdrive" },
            { binding: "CACHE", resourceId: "kv-id", type: "kv" },
            { binding: "FILES", resource: "app-files", type: "r2" },
            { binding: "VECTORS", resource: "app-index", type: "vectorize" },
        ]);
        expect(manifest.version).toBe(BINDING_MANIFEST_VERSION);
    });

    it("marks a durable object sqlite only when this worker declares the class", () => {
        expect.assertions(1);

        // A `script_name` binding points at ANOTHER worker's class, whose storage
        // mode is that worker's business — claiming it here would have a deployer
        // create a namespace with the wrong storage backend.
        const manifest = buildBindingManifest({
            durable_objects: {
                bindings: [
                    { class_name: "ShardDO", name: "SHARD" },
                    { class_name: "SessionDO", name: "SESSION" },
                    { class_name: "OtherDO", name: "REMOTE", script_name: "other-worker" },
                ],
            },
            migrations: [{ new_sqlite_classes: ["ShardDO"] }],
        });

        expect(manifest.bindings).toStrictEqual([
            { binding: "REMOTE", className: "OtherDO", type: "durable_object" },
            { binding: "SESSION", className: "SessionDO", sqlite: false, type: "durable_object" },
            { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" },
        ]);
    });

    it("reports an unmodelled wrangler section instead of dropping it", () => {
        expect.assertions(2);

        // Silence here is the dangerous outcome: a consumer would under-provision
        // and find out at runtime. A binding type added to wrangler before it is
        // added here must degrade to a name, not vanish.
        const config = { mtls_certificates: [{ binding: "CERT" }], name: "app" } as unknown as ManifestConfigShape;
        const manifest = buildBindingManifest(config);

        expect(manifest.unknown).toStrictEqual(["mtls_certificates"]);
        expect(manifest.bindings).toStrictEqual([]);
    });

    it("says nothing about the settings every real wrangler config carries", () => {
        expect.assertions(1);

        // `$schema` heads every scaffolded `wrangler.jsonc` in this repo. Reporting
        // it as unmodelled on every single run trains the user to ignore the one
        // signal the design depends on.
        const config = {
            $schema: "node_modules/wrangler/config-schema.json",
            compatibility_date: "2026-04-07",
            main: "src/index.ts",
            name: "app",
            observability: { enabled: true },
        } as unknown as ManifestConfigShape;

        expect(buildBindingManifest(config).unknown).toStrictEqual([]);
    });

    it("models the assets binding, and reports per-environment overrides it does not", () => {
        expect.assertions(2);

        // `assets` carries a real `env` binding and used to be dropped as a
        // non-binding setting. `env.<name>` genuinely is not modelled — so it has
        // to be reported, not silently ignored, or a config that declares all its
        // real bindings under `env.production` yields a manifest describing none.
        const config = {
            assets: { binding: "ASSETS", directory: "./public" },
            env: { production: { d1_databases: [{ binding: "DB" }] } },
        } as unknown as ManifestConfigShape;
        const manifest = buildBindingManifest(config);

        expect(manifest.bindings).toStrictEqual([{ binding: "ASSETS", type: "assets" }]);
        expect(manifest.unknown).toStrictEqual(["env"]);
    });

    it("reports an entry with no binding name rather than inventing one", () => {
        expect.assertions(2);

        // `{"binding": ""}` in a document whose whole purpose is being consumed by
        // an IaC program is the same failure as dropping it, wearing a different
        // hat — the program gets a resource it cannot wire to anything.
        const manifest = buildBindingManifest({ r2_buckets: [{ bucket_name: "orphan" }, { binding: "FILES", bucket_name: "files" }] });

        expect(manifest.bindings).toStrictEqual([{ binding: "FILES", resource: "files", type: "r2" }]);
        expect(manifest.unknown).toStrictEqual(["r2_buckets (entry with no binding name)"]);
    });

    it("lists var NAMES but never their values", () => {
        expect.assertions(1);

        // The manifest is written to a path a project commits and CI reads. A
        // `vars` entry can hold something the project would rather not publish,
        // and a deployer only needs to know the key exists.
        const manifest = buildBindingManifest({ vars: { API_BASE: "https://api.example.com", TENANT: "acme" } });

        expect(manifest.vars).toStrictEqual(["API_BASE", "TENANT"]);
    });

    it("keeps output diff-stable regardless of declaration order", () => {
        expect.assertions(1);

        const forward = buildBindingManifest({
            d1_databases: [{ binding: "DB" }],
            r2_buckets: [{ binding: "Z" }, { binding: "A" }],
            triggers: { crons: ["*/5 * * * *"] },
        });
        const reversed = buildBindingManifest({
            r2_buckets: [{ binding: "A" }, { binding: "Z" }],
            triggers: { crons: ["*/5 * * * *"] },
            d1_databases: [{ binding: "DB" }],
        });

        expect(forward).toStrictEqual(reversed);
    });

    it("records queue producers and consumers separately", () => {
        expect.assertions(1);

        // A consumer is a subscription, not an `env` binding — it still has to
        // reach the manifest or a deployer creates the queue and nothing drains it.
        const manifest = buildBindingManifest({
            queues: { consumers: [{ queue: "emails" }], producers: [{ binding: "EMAIL_QUEUE", queue: "emails" }] },
        });

        expect(manifest.bindings).toStrictEqual([
            { binding: "emails", resource: "emails", type: "queue_consumer" },
            { binding: "EMAIL_QUEUE", resource: "emails", type: "queue_producer" },
        ]);
    });
});
