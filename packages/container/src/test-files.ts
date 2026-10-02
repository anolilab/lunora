/**
 * An in-memory stand-in for one container instance's disk, behind the
 * `createContainerTestContext` double's `files` RPCs. Linux-shaped enough for
 * handler tests — absolute paths, directories, `ENOENT` / `EEXIST` /
 * `ENOTDIR` / `EISDIR` / `ENOTEMPTY` — and no more: no permissions, symlinks
 * or users. Errors carry the same `LunoraError` code and `data.errno` the real
 * helpers' errors are translated to.
 */
/* eslint-disable @typescript-eslint/require-await -- every method is async to honour the ContainerFiles contract; the in-memory disk itself never waits */
import { LunoraError } from "@lunora/errors";

import type { ContainerFileContent, ContainerFileOptions, ContainerFiles, SandboxDirectoryEntry, SandboxFileStat } from "./sandbox-types";

const ERRNO_CODES: Readonly<Record<string, string>> = { EEXIST: "CONFLICT", ENOENT: "NOT_FOUND", ENOTEMPTY: "CONFLICT" };

const fileError = (errno: string, operation: string, path: string): LunoraError =>
    new LunoraError(ERRNO_CODES[errno] ?? "BAD_REQUEST", `test container: ${operation} ${path} failed with ${errno}`, { data: { errno, operation, path } });

/** `path` joined onto `cwd` and normalised (`.`/`..` resolved, no trailing slash). */
const resolvePath = (path: string, options: ContainerFileOptions = {}): string => {
    const joined = path.startsWith("/") ? path : `${options.cwd ?? ""}/${path}`;

    if (!joined.startsWith("/")) {
        throw new TypeError(`test container: "${path}" is relative and no absolute \`cwd\` was given`);
    }

    const parts: string[] = [];

    for (const part of joined.split("/")) {
        if (part === "..") {
            parts.pop();
        } else if (part !== "" && part !== ".") {
            parts.push(part);
        }
    }

    return `/${parts.join("/")}`;
};

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/** Bytes of `content`, buffering a stream. */
const toBytes = async (content: ContainerFileContent): Promise<Uint8Array> => {
    if (typeof content === "string") {
        return new TextEncoder().encode(content);
    }

    if (content instanceof ArrayBuffer) {
        // A copy, so the caller reusing its buffer cannot rewrite the stored file.
        return Uint8Array.from(new Uint8Array(content));
    }

    if (ArrayBuffer.isView(content)) {
        return new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
    }

    return new Uint8Array(await new Response(content).arrayBuffer());
};

const statOf = (type: "directory" | "file", size: number): SandboxFileStat => {
    const now = new Date();

    return { accessedAt: now, changedAt: now, gid: 0, modifiedAt: now, mode: type === "directory" ? 0o4_0755 : 0o10_0644, size: BigInt(size), type, uid: 0 };
};

/** One instance's disk: `/` exists, everything else is created by the calls below. */
const createTestDisk = (): ContainerFiles => {
    const files = new Map<string, Uint8Array>();
    const directories = new Set<string>(["/"]);
    const exists = (path: string): boolean => files.has(path) || directories.has(path);
    const childrenOf = (path: string): string[] =>
        [...files.keys(), ...directories].filter((entry) => entry !== path && parentOf(entry) === path).toSorted((a, b) => a.localeCompare(b));
    const assertParent = (path: string, operation: string): void => {
        const parent = parentOf(path);

        if (files.has(parent)) {
            throw fileError("ENOTDIR", operation, path);
        }

        if (!directories.has(parent)) {
            throw fileError("ENOENT", operation, path);
        }
    };

    return {
        mkdir: async (rawPath: string, options: ContainerFileOptions & { recursive?: boolean } = {}): Promise<void> => {
            const path = resolvePath(rawPath, options);

            if (options.recursive === true) {
                let current = "";

                for (const part of path.split("/").filter(Boolean)) {
                    current = `${current}/${part}`;

                    if (files.has(current)) {
                        throw fileError("ENOTDIR", "mkdir", current);
                    }

                    directories.add(current);
                }

                return;
            }

            if (exists(path)) {
                throw fileError("EEXIST", "mkdir", path);
            }

            assertParent(path, "mkdir");
            directories.add(path);
        },
        readDirectory: async (rawPath: string, options?: ContainerFileOptions): Promise<SandboxDirectoryEntry[]> => {
            const path = resolvePath(rawPath, options);

            if (files.has(path)) {
                throw fileError("ENOTDIR", "readDirectory", path);
            }

            if (!directories.has(path)) {
                throw fileError("ENOENT", "readDirectory", path);
            }

            return childrenOf(path).map((child) => {
                return { name: child.slice(child.lastIndexOf("/") + 1), type: directories.has(child) ? "directory" : "file" };
            });
        },
        readFile: async (rawPath: string, options?: ContainerFileOptions): Promise<Response> => {
            const path = resolvePath(rawPath, options);
            const bytes = files.get(path);

            if (bytes === undefined) {
                throw fileError(directories.has(path) ? "EISDIR" : "ENOENT", "readFile", path);
            }

            return new Response(new Uint8Array(bytes));
        },
        remove: async (rawPath: string, options: ContainerFileOptions & { force?: boolean; recursive?: boolean } = {}): Promise<void> => {
            const path = resolvePath(rawPath, options);

            if (files.delete(path)) {
                return;
            }

            if (!directories.has(path)) {
                if (options.force !== true) {
                    throw fileError("ENOENT", "remove", path);
                }

                return;
            }

            if (options.recursive !== true) {
                throw fileError(childrenOf(path).length > 0 ? "ENOTEMPTY" : "EISDIR", "remove", path);
            }

            for (const entry of [...files.keys(), ...directories]) {
                if (entry === path || entry.startsWith(`${path}/`)) {
                    files.delete(entry);
                    directories.delete(entry);
                }
            }

            directories.add("/");
        },
        rename: async (rawSource: string, rawDestination: string, options?: ContainerFileOptions): Promise<void> => {
            const source = resolvePath(rawSource, options);
            const destination = resolvePath(rawDestination, options);

            if (!exists(source)) {
                throw fileError("ENOENT", "rename", source);
            }

            assertParent(destination, "rename");

            // Linux refuses to move a directory into its own subtree.
            if (destination.startsWith(`${source}/`)) {
                throw fileError("EINVAL", "rename", source);
            }

            // Snapshots: both loops add entries to the collection they walk.
            const fileEntries = [...files];
            const directoryEntries = [...directories];

            for (const [entry, bytes] of fileEntries) {
                if (entry === source || entry.startsWith(`${source}/`)) {
                    files.delete(entry);
                    files.set(destination + entry.slice(source.length), bytes);
                }
            }

            for (const entry of directoryEntries) {
                if (entry === source || entry.startsWith(`${source}/`)) {
                    directories.delete(entry);
                    directories.add(destination + entry.slice(source.length));
                }
            }
        },
        stat: async (rawPath: string, options?: ContainerFileOptions): Promise<SandboxFileStat> => {
            const path = resolvePath(rawPath, options);
            const bytes = files.get(path);

            if (bytes !== undefined) {
                return statOf("file", bytes.byteLength);
            }

            if (directories.has(path)) {
                return statOf("directory", 4096);
            }

            throw fileError("ENOENT", "stat", path);
        },
        writeFile: async (rawPath: string, content: ContainerFileContent, options?: ContainerFileOptions): Promise<void> => {
            const path = resolvePath(rawPath, options);

            if (directories.has(path)) {
                throw fileError("EISDIR", "writeFile", path);
            }

            assertParent(path, "writeFile");
            files.set(path, await toBytes(content));
        },
    };
};

export default createTestDisk;
