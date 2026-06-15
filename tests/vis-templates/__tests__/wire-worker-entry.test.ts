import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { nestFile, wireWorkerEntryReexport, WORKFLOWS_TARGET } from "../../../.vis/templates/_helpers/wire-worker-entry.js";

let workdir: string;

const write = (relativePath: string, content: string): void => {
    const full = join(workdir, relativePath);

    mkdirSync(full.slice(0, Math.max(0, full.lastIndexOf("/"))), { recursive: true });
    writeFileSync(full, content, "utf8");
};

const CLASS_BC_ENTRY = `import { createWorker } from "@lunora/runtime";
import { createShardDO } from "../lunora/_generated/shard.js";

export const ShardDO = createShardDO();
export default createWorker({});
`;

describe("wireWorkerEntryReexport", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-wire-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    test("appends the container re-export to a class-B/C entry resolved from wrangler main", () => {
        write("wrangler.jsonc", `{ "name": "app", "main": "src/server.ts" }`);
        write("src/server.ts", CLASS_BC_ENTRY);

        const result = wireWorkerEntryReexport(workdir);

        expect(result?.relativePath).toBe("src/server.ts");
        expect(result?.content).toContain('export * from "../lunora/_generated/containers.js"');
        // The original entry survives.
        expect(result?.content).toContain("export const ShardDO = createShardDO();");
    });

    test("computes the relative path for a nested entry", () => {
        write("wrangler.jsonc", `{ "main": "src/server/index.ts" }`);
        write("src/server/index.ts", CLASS_BC_ENTRY);

        const result = wireWorkerEntryReexport(workdir);

        expect(result?.relativePath).toBe("src/server/index.ts");
        expect(result?.content).toContain('export * from "../../lunora/_generated/containers.js"');
    });

    test("falls back to the conventional locations when wrangler main is absent", () => {
        write("src/index.ts", CLASS_BC_ENTRY);

        expect(wireWorkerEntryReexport(workdir)?.relativePath).toBe("src/index.ts");
    });

    test("is idempotent — returns undefined when already wired", () => {
        write("wrangler.jsonc", `{ "main": "src/server.ts" }`);
        write("src/server.ts", `${CLASS_BC_ENTRY}export * from "../lunora/_generated/containers.js";\n`);

        expect(wireWorkerEntryReexport(workdir)).toBeUndefined();
    });

    test("appends the workflows re-export when targeted with WORKFLOWS_TARGET", () => {
        write("wrangler.jsonc", `{ "main": "src/server.ts" }`);
        write("src/server.ts", CLASS_BC_ENTRY);

        const result = wireWorkerEntryReexport(workdir, WORKFLOWS_TARGET);

        expect(result?.relativePath).toBe("src/server.ts");
        expect(result?.content).toContain('export * from "../lunora/_generated/workflows.js"');
        expect(result?.content).toContain("export const ShardDO = createShardDO();");
    });

    test("workflows target is idempotent independently of the containers re-export", () => {
        write("wrangler.jsonc", `{ "main": "src/server.ts" }`);
        write("src/server.ts", `${CLASS_BC_ENTRY}export * from "../lunora/_generated/workflows.js";\n`);

        expect(wireWorkerEntryReexport(workdir, WORKFLOWS_TARGET)).toBeUndefined();
    });

    test("skips a class-A project (no createShardDO entry to touch)", () => {
        // wrangler main points at the framework/virtual worker; the file (if any)
        // doesn't call createShardDO.
        write("wrangler.jsonc", `{ "main": "src/worker.ts" }`);
        write("src/worker.ts", `export { default } from "virtual:lunora/worker";\n`);

        expect(wireWorkerEntryReexport(workdir)).toBeUndefined();
    });

    test("returns undefined when no worker entry exists at all", () => {
        expect(wireWorkerEntryReexport(workdir)).toBeUndefined();
    });
});

describe("nestFile", () => {
    test("nests a deep path into a vis files object", () => {
        expect(nestFile("src/server/index.ts", "X")).toStrictEqual({ src: { server: { "index.ts": "X" } } });
    });

    test("handles a top-level file", () => {
        expect(nestFile("worker.ts", "X")).toStrictEqual({ "worker.ts": "X" });
    });
});
