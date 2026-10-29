import { isLunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DefaultScheduledContainerConfig } from "../src/index";
import { defineContainer } from "../src/index";
import LunoraSandboxContainer from "../src/sandbox/container";
import { fakeDurableObjectContext, streamOf } from "./__helpers__/fake-context";

/** One helper instance the module mock built: its constructor args and every call. */
interface RecordedHelper {
    args: unknown[];
    calls: Record<string, unknown[][]>;
}

/** The mock's shared state: every helper it built, and the error the next helper call throws. */
interface MockState {
    backups: RecordedHelper[];
    files: RecordedHelper[];
    mounts: RecordedHelper[];
    next: { error: Error | undefined };
}

const helpers: MockState = vi.hoisted((): MockState => {
    return { backups: [], files: [], mounts: [], next: { error: undefined } };
});

// eslint-disable-next-line vitest/prefer-import-in-mock -- the factory is a partial stand-in, which the typed import() form rejects
vi.mock("@cloudflare/sandbox", () => {
    /** A helper class whose every method records its call, then throws `helpers.next.error` if set. */
    const recording = (methods: Record<string, (...args: unknown[]) => unknown>, registry: { calls: Record<string, unknown[][]> }[], keepArgs = false) =>
        class {
            public readonly calls: Record<string, unknown[][]> = {};

            public readonly args: unknown[];

            public constructor(...args: unknown[]) {
                this.args = keepArgs ? args : [];
                registry.push(this);

                for (const [name, result] of Object.entries(methods)) {
                    (this as Record<string, unknown>)[name] = async (...callArgs: unknown[]) => {
                        const calls = this.calls[name] ?? [];

                        calls.push(callArgs);
                        this.calls[name] = calls;

                        const pending = helpers.next.error;

                        if (pending !== undefined) {
                            helpers.next.error = undefined;

                            throw pending;
                        }

                        return result(...callArgs);
                    };
                }
            }
        };
    const is = (name: string) => (cause: unknown) => (cause as { name?: string } | undefined)?.name === name;

    return {
        DirectoryBackup: recording(
            {
                backup: (options) => {
                    return { dir: (options as { dir: string }).dir, format: "tar+zstd/1", id: "b1", sha256: "x", size: 3 };
                },
                delete: () => undefined,
                intercept: () => undefined,
                restore: () => undefined,
            },
            helpers.backups,
            true,
        ),
        Files: recording(
            {
                mkdir: () => undefined,
                readDirectory: () => [{ name: "a.txt", type: "file" }],
                readFile: () => new Response(streamOf("contents")),
                remove: () => undefined,
                rename: () => undefined,
                stat: () => {
                    return { size: 8n, type: "file" };
                },
                writeFile: () => undefined,
            },
            helpers.files,
        ),
        S3Mount: recording(
            {
                inspect: () => {
                    return { attachment: { status: "absent" }, mountPath: "/mnt" };
                },
                mount: () => undefined,
                unmount: () => undefined,
            },
            helpers.mounts,
            true,
        ),
        SandboxBackupError: { is: is("SandboxBackupError") },
        SandboxFileError: { is: is("SandboxFileError") },
        SandboxProtocolError: { is: is("SandboxProtocolError") },
        SandboxS3MountError: { is: is("SandboxS3MountError") },
    };
});

const DEFAULT_DEFINITION: DefaultScheduledContainerConfig = { image: "./box", sandbox: true };
const DEFAULT_EXPORTS: Record<string, unknown> = { DirectoryBackupGateway: "backup-gw", S3Gateway: "s3-gw" };
/** A Worker env carrying the `WORKSPACES` R2 bucket binding the backup tests name. */
const BUCKET_ENV: Record<string, unknown> = { WORKSPACES: { get: () => null } };

const sandboxInstance = (definition = DEFAULT_DEFINITION, exports = DEFAULT_EXPORTS, env: Record<string, unknown> = {}) => {
    const container = {
        exec: async () => {
            return {};
        },
        running: true,
    };
    const instance = new LunoraSandboxContainer(fakeDurableObjectContext(container, exports) as never, env, defineContainer(definition as never), "box");

    return { inflight: () => (instance as unknown as { inflightRequests: number }).inflightRequests, instance };
};

/** The error a promise rejects with. */
const rejection = async (pending: Promise<unknown>): Promise<unknown> =>
    pending.then(
        () => undefined,
        (error: unknown) => error,
    );

describe(LunoraSandboxContainer, () => {
    beforeEach(() => {
        helpers.backups.length = 0;
        helpers.files.length = 0;
        helpers.mounts.length = 0;
        helpers.next.error = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("streams a file out, holding the container in flight until the body is read", async () => {
        expect.assertions(3);

        const { inflight, instance } = sandboxInstance();
        const response = await instance.lunoraReadFile("/w/a.txt", { cwd: "/w" });

        expect(inflight()).toBe(1);
        await expect(response.text()).resolves.toBe("contents");

        await vi.waitFor(() => {
            expect(inflight()).toBe(0);
        });
    });

    it("forwards each file operation to one Files helper", async () => {
        expect.assertions(3);

        const { inflight, instance } = sandboxInstance();

        await instance.lunoraWriteFile("/w/a.txt", "hi");
        await instance.lunoraMkdir("/w/sub", { recursive: true });

        await expect(instance.lunoraReadDirectory("/w")).resolves.toStrictEqual([{ name: "a.txt", type: "file" }]);

        expect(helpers.files).toHaveLength(1);
        expect(inflight()).toBe(0);
    });

    it("translates a filesystem error into a LunoraError carrying the errno", async () => {
        expect.assertions(3);

        const { inflight, instance } = sandboxInstance();

        helpers.next.error = Object.assign(new Error("missing"), {
            code: "ENOENT",
            detail: "no such file",
            name: "SandboxFileError",
            operation: "stat",
            path: "/nope",
        });

        const error = await rejection(instance.lunoraStat("/nope"));

        expect(isLunoraError(error) && error.code).toBe("NOT_FOUND");
        expect((error as { data?: unknown }).data).toStrictEqual({ errno: "ENOENT", operation: "stat", path: "/nope" });
        expect(inflight()).toBe(0);
    });

    it("points at the image when the sandbox-shim protocol fails", async () => {
        expect.assertions(2);

        const { instance } = sandboxInstance();

        helpers.next.error = Object.assign(new Error("bad frame"), { detail: "unexpected EOF", name: "SandboxProtocolError" });

        const error = await rejection(instance.lunoraStat("/x"));

        expect(isLunoraError(error) && error.code).toBe("INTERNAL");
        expect(String((error as { hint?: unknown }).hint)).toContain("sandbox-shim");
    });

    it("backs up to the configured bucket through the exported gateway", async () => {
        expect.assertions(2);

        const { instance } = sandboxInstance({ backups: { bucket: "WORKSPACES", prefix: "ws/" }, image: "./box", sandbox: true }, undefined, BUCKET_ENV);
        const record = await instance.lunoraBackup("/workspace", { exclude: ["node_modules"], name: "nightly" });

        expect(record.id).toBe("b1");
        expect(helpers.backups[0]!.args.slice(1)).toStrictEqual(["backup-gw", { binding: "WORKSPACES", prefix: "ws/" }]);
    });

    it("refuses a backup without `backups` config, and names a missing bucket binding or gateway export", async () => {
        expect.assertions(3);

        await expect(sandboxInstance().instance.lunoraBackup("/workspace")).rejects.toThrow("backups need `backups: { bucket }`");
        await expect(sandboxInstance({ backups: { bucket: "WORKSPACES" }, image: "./box", sandbox: true }).instance.lunoraBackup("/workspace")).rejects.toThrow(
            'backups.bucket "WORKSPACES" is not an R2 bucket binding',
        );
        await expect(
            sandboxInstance({ backups: { bucket: "WORKSPACES" }, image: "./box", sandbox: true }, {}, BUCKET_ENV).instance.lunoraBackup("/workspace"),
        ).rejects.toThrow("the worker does not export DirectoryBackupGateway");
    });

    it("registers the backup route before the egress catch-all only when interception is on", async () => {
        expect.assertions(2);

        const plain = sandboxInstance({ backups: { bucket: "WORKSPACES" }, image: "./box", sandbox: true }).instance;

        await (plain as unknown as { beforeContainerStart: () => Promise<void> }).beforeContainerStart();

        expect(helpers.backups).toHaveLength(0);

        const fenced = sandboxInstance(
            { allowedHosts: ["api.example.com"], backups: { bucket: "WORKSPACES" }, image: "./box", sandbox: true },
            undefined,
            BUCKET_ENV,
        ).instance;

        (fenced as unknown as { usingInterception: boolean }).usingInterception = true;
        await (fenced as unknown as { beforeContainerStart: () => Promise<void> }).beforeContainerStart();

        expect(helpers.backups[0]!.calls.intercept).toHaveLength(1);
    });

    it("mounts with credentials read from the Worker secrets the request names", async () => {
        expect.assertions(2);

        const { instance } = sandboxInstance(undefined, undefined, { R2_KEY: "AK", R2_SECRET: "SK" });

        await instance.lunoraMount({
            access: "read-only",
            bucket: "assets",
            credentials: { accessKeyIdSecret: "R2_KEY", secretAccessKeySecret: "R2_SECRET" },
            endpoint: "https://acct.r2.cloudflarestorage.com",
            path: "/mnt/assets",
            region: "auto",
        });

        expect(helpers.mounts[0]!.args[1]).toBe("s3-gw");
        expect(helpers.mounts[0]!.calls.mount![0]![0]).toStrictEqual({
            access: "read-only",
            mountPath: "/mnt/assets",
            source: {
                bucket: "assets",
                credentials: { accessKeyId: "AK", secretAccessKey: "SK", type: "static" },
                endpoint: "https://acct.r2.cloudflarestorage.com",
                region: "auto",
                type: "s3",
            },
        });
    });

    it("refuses a mount whose credential secret is unset, or on a container with an egress policy", async () => {
        expect.assertions(2);

        const request = {
            access: "read-write" as const,
            bucket: "assets",
            credentials: { accessKeyIdSecret: "R2_KEY", secretAccessKeySecret: "R2_SECRET" },
            endpoint: "https://acct.r2.cloudflarestorage.com",
            path: "/mnt/assets",
            region: "auto",
        };

        await expect(sandboxInstance().instance.lunoraMount(request)).rejects.toThrow('credential secret "R2_KEY" is not set');

        const fenced = sandboxInstance(undefined, undefined, { R2_KEY: "AK", R2_SECRET: "SK" }).instance;

        (fenced as unknown as { usingInterception: boolean }).usingInterception = true;

        await expect(fenced.lunoraMount(request)).rejects.toThrow("bucket mounts cannot be combined with an egress policy");
    });
});
