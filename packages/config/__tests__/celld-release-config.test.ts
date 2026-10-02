import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CelldReleaseManifest, CelldReleaseOptions } from "../src/celld";
import { CELLD_RELEASE_BINDING_TYPES, celldConfigFromRelease, CelldReleaseConfigError, releaseResourceName } from "../src/celld";
import type { BindingRequirement } from "../src/cloudflare/binding-manifest";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`__fixtures__/celld-release/${name}`, import.meta.url), "utf8"));

const options = (overrides: Partial<CelldReleaseOptions> = {}): CelldReleaseOptions => {
    return { alias: "my-app", crons: [], hasAssets: false, vars: {}, ...overrides };
};

const manifestOf = (...bindings: BindingRequirement[]): CelldReleaseManifest => {
    return { bindings };
};

describe(celldConfigFromRelease, () => {
    it.each(["full", "minimal"])("turns the %s release manifest into its golden celld config", (name) => {
        expect.assertions(1);

        const input = fixture(`${name}.input.json`) as { manifest: CelldReleaseManifest; options: CelldReleaseOptions };

        expect(celldConfigFromRelease(input.manifest, input.options)).toStrictEqual(fixture(`${name}.config.json`));
    });

    it("prefers the job's compatibility date and falls back to the manifest's", () => {
        expect.assertions(2);

        const manifest: CelldReleaseManifest = { bindings: [], compatibilityDate: "2026-01-01" };

        expect(celldConfigFromRelease(manifest, options())["compatibility_date"]).toBe("2026-01-01");
        expect(celldConfigFromRelease(manifest, options({ compatibilityDate: "2026-09-01" }))["compatibility_date"]).toBe("2026-09-01");
    });

    it("names a consumer of a queue nobody produces to by its own binding", () => {
        expect.assertions(1);

        const config = celldConfigFromRelease(manifestOf({ binding: "inbound", resource: "inbound", type: "queue_consumer" }), options());

        expect(config["queues"]).toStrictEqual({ consumers: [{ queue: "my-app--inbound" }] });
    });

    it.each([
        "ai",
        "analytics_engine",
        "artifacts",
        "browser",
        "container",
        "hyperdrive",
        "images",
        "media",
        "pipeline",
        "stream",
        "vectorize",
        "vpc_network",
        "vpc_service",
    ] as const)("refuses a %s binding by name", (type) => {
        expect.assertions(2);

        const run = (): unknown => celldConfigFromRelease(manifestOf({ binding: "THING", type }), options());

        expect(run).toThrow(CelldReleaseConfigError);
        expect(run).toThrow(new RegExp(String.raw`THING \(${type}\)`, "u"));
    });

    it("lists every refused binding at once", () => {
        expect.assertions(1);

        const caught = ((): unknown => {
            try {
                return celldConfigFromRelease(
                    manifestOf({ binding: "AI", type: "ai" }, { binding: "VEC", type: "vectorize" }, { binding: "DB", type: "d1" }),
                    options(),
                );
            } catch (error) {
                return error;
            }
        })();

        expect((caught as CelldReleaseConfigError).refused.map((entry) => entry.binding)).toStrictEqual(["AI", "VEC"]);
    });

    it("refuses a KV-backed Durable Object class, which celld cannot create", () => {
        expect.assertions(1);

        expect(() => celldConfigFromRelease(manifestOf({ binding: "OLD", className: "Legacy", sqlite: false, type: "durable_object" }), options())).toThrow(
            /class Legacy is KV-backed/u,
        );
    });

    it("refuses a Durable Object binding to another Worker's class", () => {
        expect.assertions(1);

        expect(() => celldConfigFromRelease(manifestOf({ binding: "REMOTE", className: "Elsewhere", type: "durable_object" }), options())).toThrow(
            /belongs to another Worker/u,
        );
    });

    it("refuses assets that do not match the manifest", () => {
        expect.assertions(2);

        expect(() => celldConfigFromRelease(manifestOf(), options({ hasAssets: true }))).toThrow(/no assets binding/u);
        expect(() => celldConfigFromRelease(manifestOf({ binding: "ASSETS", type: "assets" }), options())).toThrow(/carries no assets/u);
    });

    it("refuses a malformed alias and an over-long resource name", () => {
        expect.assertions(2);

        expect(() => celldConfigFromRelease(manifestOf({ binding: "DB", type: "d1" }), options({ alias: "My_App" }))).toThrow(/alias "My_App"/u);
        expect(() => celldConfigFromRelease(manifestOf({ binding: "D".repeat(60), type: "d1" }), options())).toThrow(/exceeds 63 characters/u);
    });

    it("emits only keys celld accepts", () => {
        expect.assertions(1);

        const input = fixture("full.input.json") as { manifest: CelldReleaseManifest; options: CelldReleaseOptions };
        const accepted = new Set([
            "assets",
            "compatibility_date",
            "compatibility_flags",
            "d1_databases",
            "durable_objects",
            "kv_namespaces",
            "main",
            "migrations",
            "name",
            "no_bundle",
            "queues",
            "r2_buckets",
            "triggers",
            "vars",
            "workflows",
        ]);

        expect(Object.keys(celldConfigFromRelease(input.manifest, input.options)).filter((key) => !accepted.has(key))).toStrictEqual([]);
    });
});

describe(releaseResourceName, () => {
    it("is {alias}--{binding}, lowercased with _ → -", () => {
        expect.assertions(1);

        expect(releaseResourceName("my-app", "USER_FILES")).toBe("my-app--user-files");
    });

    it("keeps two tenants apart where a single dash would not", () => {
        expect.assertions(1);

        expect(releaseResourceName("app", "B_DB")).not.toBe(releaseResourceName("app-b", "DB"));
    });
});

describe("celld release binding types", () => {
    it("lists the binding types a celld fleet runs", () => {
        expect.assertions(1);

        expect([...CELLD_RELEASE_BINDING_TYPES].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "assets",
            "d1",
            "durable_object",
            "kv",
            "queue_consumer",
            "queue_producer",
            "r2",
            "workflow",
        ]);
    });
});
