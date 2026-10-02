/**
 * Request and result shapes for the Sandbox SDK helpers on a
 * `defineContainer({ sandbox: true })` instance (`handle.files`,
 * `handle.backup`, `handle.mount`). Node-safe: only `import type` from
 * `@cloudflare/sandbox`, so the package root never loads it.
 */
import type { DirectoryBackupRecord, S3MountInspection, SandboxDirectoryEntry, SandboxFileStat } from "@cloudflare/sandbox";

/** Options every file operation accepts. */
interface ContainerFileOptions {
    /** Absolute directory a relative path is joined onto. */
    cwd?: string;
    /** Numeric `uid:gid` that opens the file. */
    user?: string;
}

/** What `handle.files.writeFile` accepts. A stream is written as it arrives. */
type ContainerFileContent = ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string;

/**
 * Structured file operations on the instance's own disk (`handle.files`),
 * through `@cloudflare/sandbox`'s `Files`. A filesystem failure rejects with a
 * `LunoraError` whose `data.errno` is the Linux code (`ENOENT`, `EACCES`, …).
 */
interface ContainerFiles {
    /** Create a directory; `recursive` creates parents and accepts an existing one. */
    mkdir: (path: string, options?: ContainerFileOptions & { recursive?: boolean }) => Promise<void>;
    /** List a directory's immediate entries, without following symlinked entries. */
    readDirectory: (path: string, options?: ContainerFileOptions) => Promise<SandboxDirectoryEntry[]>;
    /** Stream a file out of the container. The body applies backpressure to the read. */
    readFile: (path: string, options?: ContainerFileOptions) => Promise<Response>;
    /** Remove a file or symlink; `recursive` removes a directory tree, `force` ignores a missing target. */
    remove: (path: string, options?: ContainerFileOptions & { force?: boolean; recursive?: boolean }) => Promise<void>;
    /** Rename within one filesystem (`EXDEV` across filesystems; there is no copy fallback). */
    rename: (source: string, destination: string, options?: ContainerFileOptions) => Promise<void>;
    /** Metadata for a path, following a final symlink. */
    stat: (path: string, options?: ContainerFileOptions) => Promise<SandboxFileStat>;
    /** Create or truncate a file and write `content` into it. */
    writeFile: (path: string, content: ContainerFileContent, options?: ContainerFileOptions) => Promise<void>;
}

/** Options for `handle.backup()`. */
interface ContainerBackupOptions {
    /** gitignore-syntax patterns, relative to the directory, to leave out. */
    exclude?: ReadonlyArray<string>;
    /** Also apply `.gitignore` files inside the directory and `.git/info/exclude`. */
    gitignore?: boolean;
    /** A label stored with the backup. */
    name?: string;
}

/**
 * Credentials for an S3-compatible bucket mount, by **name**: each value is the
 * name of a Worker secret (`wrangler secret put`) the container Durable Object
 * reads at mount time. The keys themselves never appear in source, and the
 * Worker signs every storage request, so they never enter the container either.
 */
interface ContainerMountCredentials {
    /** Worker secret holding the access key id. */
    accessKeyIdSecret: string;
    /** Worker secret holding the secret access key. */
    secretAccessKeySecret: string;
    /** Worker secret holding a session token, for temporary credentials. */
    sessionTokenSecret?: string;
}

/**
 * An S3-compatible bucket (R2, S3, GCS) to mount at `path` with
 * `handle.mount()`. For R2 the endpoint is
 * `https://<account-id>.r2.cloudflarestorage.com` with region `"auto"`, and the
 * credentials are an R2 API token's S3 keys — an R2 bucket binding is not used.
 */
interface ContainerMountRequest {
    access: "read-only" | "read-write";
    bucket: string;
    credentials: ContainerMountCredentials;
    endpoint: string;
    /** Mount only this key prefix. A non-empty prefix ends in `/`. */
    keyPrefix?: string;
    /** Absolute path inside the container to mount at. */
    path: string;
    region: string;
    /** Extra s3fs options, passed through as-is. */
    s3fsOptions?: Readonly<Record<string, boolean | number | string>>;
}

/** The sandbox operations on a named instance of a `defineContainer({ sandbox: true })` container. */
interface ContainerSandboxControls {
    /**
     * Save `directory` to the R2 bucket in the definition's `backups` and return its
     * record — plain data to store and pass to `restore` later, here or on
     * another instance, even one on a newer image. Pause writers in it first.
     */
    backup: (directory: string, options?: ContainerBackupOptions) => Promise<DirectoryBackupRecord>;
    /** Delete a backup's object. Deleting one that is already gone succeeds. */
    deleteBackup: (backup: DirectoryBackupRecord) => Promise<void>;
    /** Structured file operations on the instance's disk. */
    files: ContainerFiles;
    /** Report a mount path's state without changing it. */
    inspectMount: (path: string) => Promise<S3MountInspection>;
    /** Mount an S3-compatible bucket at `request.path`. Mounting the same settings again reuses the mount. */
    mount: (request: ContainerMountRequest) => Promise<void>;

    /**
     * Replace `options.directory` (default: the directory it was taken from) with the
     * backup's contents. The target is swapped in only after the download is
     * verified; a rejection means it was not replaced.
     */
    restore: (backup: DirectoryBackupRecord, options?: { directory?: string }) => Promise<void>;
    /** Stop access to a mount and unmount it. Never force-unmounts a busy path. */
    unmount: (path: string) => Promise<void>;
}

export type { DirectoryBackupRecord, S3MountInspection, SandboxDirectoryEntry, SandboxFileStat } from "@cloudflare/sandbox";
export type {
    ContainerBackupOptions,
    ContainerFileContent,
    ContainerFileOptions,
    ContainerFiles,
    ContainerMountCredentials,
    ContainerMountRequest,
    ContainerSandboxControls,
};
