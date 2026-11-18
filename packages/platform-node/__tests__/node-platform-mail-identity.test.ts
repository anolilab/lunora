import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Two distinct files whose inode numbers differ only beyond 2^53, as on a large or network
 * filesystem: equal once read as a Number, distinct as a bigint. Only `statSync` is replaced, and
 * only for these two names, so better-sqlite3 (which reads the real filesystem) opens real files.
 */
const { DEVICE, MAIL_INODE, SHARD_INODE } = vi.hoisted(() => {
    return { DEVICE: 7n, MAIL_INODE: 2n ** 53n + 1n, SHARD_INODE: 2n ** 53n };
});

vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();

    const inodes: Record<string, bigint> = { "mail-big.sqlite3": MAIL_INODE, "shard-big.sqlite3": SHARD_INODE };

    const statSync = ((path: string, options?: { bigint?: boolean }) => {
        const inode = Object.entries(inodes).find(([name]) => path.endsWith(name))?.[1];

        if (inode === undefined) {
            return actual.statSync(path, options);
        }

        return options?.bigint === true ? { dev: DEVICE, ino: inode, isFile: () => true } : { dev: Number(DEVICE), ino: Number(inode), isFile: () => true };
    }) as typeof actual.statSync;

    return { ...actual, statSync };
});

const { createNodePlatform } = await import("../src/node-platform");

describe("mail file identity", () => {
    let directory: string | undefined;

    afterEach(() => {
        if (directory !== undefined) {
            rmSync(directory, { force: true, recursive: true });
            directory = undefined;
        }
    });

    it("tells apart two files whose inodes collide once read as a Number", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-mail-bigint-"));

        const root = directory;

        // Number(2n ** 53n) === Number(2n ** 53n + 1n): without bigint these are "the same file".
        using platform = createNodePlatform({
            mail: {
                env: { MAIL_FROM: "Acme <noreply@acme.test>", NODE_ENV: "production" },
                path: join(root, "mail-big.sqlite3"),
                transport: {
                    send: async () => {
                        return { id: "x" };
                    },
                },
            },
            path: join(root, "shard-big.sqlite3"),
        });

        expect(platform.mail).toBeDefined();
    });
});
