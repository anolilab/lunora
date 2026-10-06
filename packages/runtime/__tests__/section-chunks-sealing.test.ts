import { describe, expect, it } from "vitest";

import type { WorkerOptions } from "../src/create-worker";
import type { ChunkRecord, StagingStore } from "../src/section-chunks";
import { collectChunks, currentSession, stageChunk, stagedChunks, stagingRoot, stagingStore } from "../src/section-chunks";

const SECRET = "admin-token-for-sealing";

/** An in-memory bucket behind the four storage ops staging uses. */
const memoryStore = (secret = SECRET): { objects: Map<string, Uint8Array<ArrayBuffer>>; store: StagingStore } => {
    const objects = new Map<string, Uint8Array<ArrayBuffer>>();
    const options: Partial<WorkerOptions> = {
        adminToken: secret,
        storageDelete: (key) => {
            objects.delete(key);
        },
        storageDownload: async (key) => {
            const bytes = objects.get(key);

            return bytes === undefined ? null : { body: new Response(bytes).body, size: bytes.byteLength };
        },
        storageList: async (prefix) => {
            const keys = [...objects.keys()].filter((key) => key.startsWith(prefix ?? "")).toSorted((a, b) => a.localeCompare(b));

            return {
                objects: keys.map((key) => {
                    return { etag: key, key, size: objects.get(key)?.byteLength ?? 0 };
                }),
            };
        },
        storageUpload: (key, body) => {
            objects.set(key, new Uint8Array(body));

            return { key };
        },
    };
    const store = stagingStore(options as WorkerOptions);

    if (store === undefined) {
        throw new Error("staging should be configured");
    }

    return { objects, store };
};

const plain = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

const chunk = (offset: number, text: string, lastSize?: number): ChunkRecord => {
    return { bytes: plain(text), lastSize, offset };
};

describe("restore staging seals its chunks", () => {
    it("stages ciphertext only, and reads it back as the original bytes", async () => {
        expect.hasAssertions();

        const { objects, store } = memoryStore();
        const root = await stagingRoot("kv:SESSIONS:token-key");

        await expect(stageChunk(store, root, {}, chunk(0, "secret-session-token-"))).resolves.toBe(true);

        const [staged] = [...objects.values()];

        expect(new TextDecoder().decode(staged)).not.toContain("secret-session-token");

        const session = await currentSession(store, root, {});
        const bytes = await collectChunks(stagedChunks(store, {}, session!, chunk(21, "tail", 25), "KV"), 25);

        expect(new TextDecoder().decode(bytes)).toBe("secret-session-token-tail");
    });

    it("refuses a staged chunk that was moved to another position or sealed under another secret", async () => {
        expect.hasAssertions();

        const { objects, store } = memoryStore();
        const root = await stagingRoot("storage:default:a.bin");

        await stageChunk(store, root, {}, chunk(0, "aaaa"));
        await stageChunk(store, root, {}, chunk(4, "bbbb"));

        const session = (await currentSession(store, root, {}))!;
        const keys = [...objects.keys()].toSorted((a, b) => a.localeCompare(b));

        // Swap the two staged objects: each is still valid ciphertext, but bound to the other key.
        const [first, second] = keys.map((key) => objects.get(key)!);

        objects.set(keys[0]!, second!);
        objects.set(keys[1]!, first!);

        await expect(collectChunks(stagedChunks(store, {}, session, chunk(8, "cc", 10), "STORAGE"), 10)).rejects.toMatchObject({
            code: "STORAGE_RESTORE_INCOMPLETE",
        });

        const other = memoryStore("a-different-deployment");

        for (const [key, value] of objects) {
            other.objects.set(key, value);
        }

        await expect(collectChunks(stagedChunks(other.store, {}, session, chunk(8, "cc", 10), "STORAGE"), 10)).rejects.toMatchObject({
            code: "STORAGE_RESTORE_INCOMPLETE",
        });
    });

    it("has no staging without an admin token to seal under", () => {
        expect.hasAssertions();

        expect(
            stagingStore({
                storageDelete: () => undefined,
                storageDownload: async () => null,
                storageList: async () => {
                    return { objects: [] };
                },
                storageUpload: (key: string) => {
                    return { key };
                },
            } as never),
        ).toBeUndefined();
    });
});
