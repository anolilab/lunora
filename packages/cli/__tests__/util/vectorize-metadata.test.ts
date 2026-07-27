import { describe, expect, it } from "vitest";

import type { Logger } from "../../src/util/logger";
import type { SpawnDescriptor, SpawnResult } from "../../src/util/spawn";
import { createMetadataIndexArgs, ensureVectorMetadataIndexes, metadataTypeFor } from "../../src/util/vectorize-metadata";

/**
 * Vectorize will not filter on a metadata property that has no index, and it
 * signals that by returning nothing — no error, no warning. So the provisioning
 * step has to be reliable in the boring ways: idempotent across re-deploys, and
 * incapable of failing a deploy that has already published a live worker.
 */

/** Records what the provisioning step told the user, in order. */
const recordingLogger = (): { logger: Logger; warnings: string[] } => {
    const warnings: string[] = [];
    const noop = (): void => {};

    return {
        logger: {
            error: noop,
            info: noop,
            success: noop,
            warn: (message: string) => {
                warnings.push(message);
            },
        },
        warnings,
    };
};

const spawnerReturning = (results: SpawnResult[]): { calls: SpawnDescriptor[]; spawner: (descriptor: SpawnDescriptor) => Promise<SpawnResult> } => {
    const calls: SpawnDescriptor[] = [];
    let index = 0;

    return {
        calls,
        spawner: (descriptor) => {
            calls.push(descriptor);

            const result = results[index] ?? { code: 0 };

            index += 1;

            return Promise.resolve(result);
        },
    };
};

describe("metadataTypeFor", () => {
    it("maps column kinds onto the three types Vectorize can index", () => {
        expect.assertions(3);

        expect(["string", "id", "literal"].map((kind) => metadataTypeFor(kind))).toStrictEqual(["string", "string", "string"]);
        expect(["number", "timestamp", "date"].map((kind) => metadataTypeFor(kind))).toStrictEqual(["number", "number", "number"]);
        expect(metadataTypeFor("boolean")).toBe("boolean");
    });

    it("returns undefined for a kind no filter could match", () => {
        expect.assertions(1);

        // Stored with the vector, but not filterable — the caller reports this
        // rather than creating an index that could never work.
        expect(["object", "array", "bytes", undefined].map((kind) => metadataTypeFor(kind))).toStrictEqual([undefined, undefined, undefined, undefined]);
    });
});

describe("ensureVectorMetadataIndexes", () => {
    it("creates one index per declared property", async () => {
        expect.assertions(2);

        const { calls, spawner } = spawnerReturning([{ code: 0 }, { code: 0 }]);

        const results = await ensureVectorMetadataIndexes({
            cwd: "/app",
            entries: [
                { index: "docs-body", property: "authorId", type: "string" },
                { index: "docs-body", property: "published", type: "boolean" },
            ],
            exec: { args: ["wrangler"], command: "npx" },
            logger: recordingLogger().logger,
            spawner,
        });

        expect(results.map((result) => result.status)).toStrictEqual(["created", "created"]);
        expect(calls.map((call) => call.args)).toStrictEqual([
            ["wrangler", "vectorize", "create-metadata-index", "docs-body", "--property-name=authorId", "--type=string"],
            ["wrangler", "vectorize", "create-metadata-index", "docs-body", "--property-name=published", "--type=boolean"],
        ]);
    });

    it("treats an already-indexed property as success, so re-deploys are quiet", async () => {
        expect.assertions(2);

        const { logger, warnings } = recordingLogger();
        const { spawner } = spawnerReturning([{ code: 1, stderr: "✘ [ERROR] A metadata index for property authorId already exists" }]);

        const results = await ensureVectorMetadataIndexes({
            cwd: "/app",
            entries: [{ index: "docs-body", property: "authorId", type: "string" }],
            exec: { args: ["wrangler"], command: "npx" },
            logger,
            spawner,
        });

        expect(results[0]?.status).toBe("exists");
        expect(warnings).toStrictEqual([]);
    });

    it("reports a real failure with the command to run, without throwing", async () => {
        expect.assertions(3);

        const { logger, warnings } = recordingLogger();
        const { spawner } = spawnerReturning([{ code: 1, stderr: "✘ [ERROR] index not found" }]);

        // The worker is already live by this point, so a provisioning failure
        // must degrade to a warning rather than fail the deploy.
        const results = await ensureVectorMetadataIndexes({
            cwd: "/app",
            entries: [{ index: "docs-body", property: "authorId", type: "string" }],
            exec: { args: ["wrangler"], command: "npx" },
            logger,
            spawner,
        });

        expect(results[0]?.status).toBe("failed");
        expect(results[0]?.error).toContain("index not found");
        expect(warnings[0]).toContain("vectorize create-metadata-index docs-body --property-name=authorId --type=string");
    });

    it("keeps provisioning the rest after one property fails", async () => {
        expect.assertions(1);

        const { spawner } = spawnerReturning([{ code: 1, stderr: "boom" }, { code: 0 }]);

        const results = await ensureVectorMetadataIndexes({
            cwd: "/app",
            entries: [
                { index: "docs-body", property: "authorId", type: "string" },
                { index: "docs-body", property: "published", type: "boolean" },
            ],
            exec: { args: ["wrangler"], command: "npx" },
            logger: recordingLogger().logger,
            spawner,
        });

        expect(results.map((result) => result.status)).toStrictEqual(["failed", "created"]);
    });
});

describe("stream handling", () => {
    it("reads the outcome from stderr, which is where wrangler reports it", async () => {
        expect.assertions(2);

        const { calls, spawner } = spawnerReturning([{ code: 1, stderr: "already indexed" }]);
        const { logger, warnings } = recordingLogger();

        const results = await ensureVectorMetadataIndexes({
            cwd: "/app",
            entries: [{ index: "docs-body", property: "authorId", type: "string" }],
            exec: { args: ["wrangler"], command: "npx" },
            logger,
            spawner,
        });

        // stdout stays untouched so `deploy --format json` keeps emitting one
        // JSON document; the reason comes from the captured stderr.
        expect(calls[0]).toMatchObject({ captureStderr: true, stdoutToStderr: true });
        expect([results[0]?.status, warnings.length]).toStrictEqual(["exists", 0]);
    });
});

describe("createMetadataIndexArgs", () => {
    it("renders the exact command a user can paste", () => {
        expect.assertions(1);

        expect(createMetadataIndexArgs({ index: "docs-body", property: "authorId", type: "string" }).join(" ")).toBe(
            "vectorize create-metadata-index docs-body --property-name=authorId --type=string",
        );
    });
});
