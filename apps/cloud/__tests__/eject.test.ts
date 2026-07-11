import { describe, expect, it } from "vitest";

import { buildByoWrangler, runEject } from "../src/cli/eject";

/** `lunora eject` — the no-lock-in exit hatch (GAPS.md D2). */

const target = {
    adminToken: "tok",
    appDomain: "lunora.app",
    projectSlug: "acme-app",
    scriptName: "acme-app",
    url: "https://acme-app.lunora.app",
};

describe(buildByoWrangler, () => {
    it("scaffolds a parseable BYO config with the DO bindings and D1 placeholder", () => {
        const config = JSON.parse(buildByoWrangler(target)) as Record<string, unknown>;

        expect(config["name"]).toBe("acme-app");
        expect(config["durable_objects"]).toStrictEqual({
            bindings: [
                { class_name: "ShardDO", name: "SHARD" },
                { class_name: "SessionDO", name: "SESSION" },
            ],
        });
        expect(JSON.stringify(config["d1_databases"])).toContain("wrangler d1 create acme-app");
        expect(config["migrations"]).toStrictEqual([{ new_sqlite_classes: ["ShardDO", "SessionDO"], tag: "v1" }]);
    });
});

describe(runEject, () => {
    it("pulls the snapshot through the admin API and writes all three files", async () => {
        const written = new Map<string, string>();
        const calls: string[] = [];

        const result = await runEject(target, {
            fetchAdmin: (url, path, adminToken) => {
                calls.push(`${url}${path}|${adminToken}`);

                return Promise.resolve('{"table":"users","row":{}}\n');
            },
            writeFile: (name, content) => {
                written.set(name, content);

                return Promise.resolve();
            },
        });

        expect(calls).toStrictEqual(["https://acme-app.lunora.app/_lunora/admin/export|tok"]);
        expect(result.files).toStrictEqual(["export.ndjson", "wrangler.jsonc", "README.md"]);
        expect(written.get("export.ndjson")).toContain('"table":"users"');
        expect(written.get("README.md")).toContain("wrangler d1 create acme-app");
    });

    it("propagates a snapshot failure without writing anything", async () => {
        const written = new Map<string, string>();

        await expect(
            runEject(target, {
                fetchAdmin: () => Promise.reject(new Error("export failed")),
                writeFile: (name, content) => {
                    written.set(name, content);

                    return Promise.resolve();
                },
            }),
        ).rejects.toThrow("export failed");
        expect(written.size).toBe(0);
    });
});
