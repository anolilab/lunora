import { describe, expect, it } from "vitest";

import { buildByoWrangler, runEject } from "../src/util/eject";

/** `lunora cloud eject` — the no-lock-in exit hatch (GAPS.md D2). */

const target = {
    projectSlug: "acme-app",
    scriptName: "acme-app",
    url: "https://acme-app.lunora.app",
};

describe(buildByoWrangler, () => {
    it("scaffolds a parseable BYO config with the DO bindings and D1 placeholder", () => {
        expect.assertions(4);

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
    it("writes all three files from the control plane's package", async () => {
        expect.assertions(4);

        const written = new Map<string, string>();

        const result = await runEject({
            fetchPackage: () => Promise.resolve({ ...target, snapshot: '{"table":"users","row":{}}\n' }),
            writeFile: (name, content) => {
                written.set(name, content);

                return Promise.resolve();
            },
        });

        expect(result.files).toStrictEqual(["export.ndjson", "wrangler.jsonc", "README.md"]);
        expect(written.get("export.ndjson")).toContain('"table":"users"');
        expect(written.get("README.md")).toContain("wrangler d1 create acme-app");
        expect(written.get("README.md")).toContain("https://acme-app.lunora.app");
    });

    /**
     * A half-written eject directory is worse than none: it looks like a backup
     * and is not one. The fetch therefore has to complete before the first write.
     */
    it("writes nothing when the export fails", async () => {
        expect.assertions(2);

        const written = new Map<string, string>();

        await expect(
            runEject({
                fetchPackage: () => Promise.reject(new Error("export failed")),
                writeFile: (name, content) => {
                    written.set(name, content);

                    return Promise.resolve();
                },
            }),
        ).rejects.toThrow("export failed");
        expect(written.size).toBe(0);
    });
});
