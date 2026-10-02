/**
 * `LunoraSandboxContainer` — the base class codegen extends for a
 * `defineContainer({ sandbox: true })` container. Adds the Sandbox SDK helpers
 * (`@cloudflare/sandbox`: `Files`, `DirectoryBackup`, `S3Mount`) to
 * `LunoraContainer` as RPC methods the named-instance handle calls.
 *
 * A subclass rather than methods on `LunoraContainer`, so a container that
 * never opts in never bundles `@cloudflare/sandbox`.
 */
import type {
    DirectoryBackupGatewayBinding,
    DirectoryBackupRecord,
    FileContent,
    S3GatewayBinding,
    S3MountInspection,
    SandboxDirectoryEntry,
    SandboxFileStat,
} from "@cloudflare/sandbox";
import { DirectoryBackup, Files, S3Mount } from "@cloudflare/sandbox";
import { LunoraError } from "@lunora/errors";

import { LunoraContainer } from "../do/index";
import type { ContainerBackupOptions, ContainerFileContent, ContainerFileOptions, ContainerMountRequest } from "../sandbox-types";
import type { ContainerBackupStorage, ContainerDefinition } from "../types";
import toSandboxError from "./errors";

type DurableObjectContext = ConstructorParameters<typeof LunoraContainer>[0];

/** The helpers' container type: the runtime's `ctx.container`. */
type HelperContainer = ConstructorParameters<typeof DirectoryBackup>[0];

/** Pass a stream body through, calling `release` once it is fully read or cancelled. */
const releaseWhenRead = (response: Response, release: () => void): Response => {
    if (response.body === null) {
        release();

        return response;
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

    response.body
        .pipeTo(writable)
        .finally(release)
        .catch(() => undefined);

    return new Response(readable, response);
};

class LunoraSandboxContainer<Env = unknown> extends LunoraContainer<Env> {
    readonly #backupStorage: ContainerBackupStorage | undefined;

    #files?: Files;

    #backups?: DirectoryBackup;

    #mounts?: S3Mount;

    public constructor(
        context: DurableObjectContext,
        env: Env,
        definition: ContainerDefinition,
        exportName?: string,
        jurisdiction?: ConstructorParameters<typeof LunoraContainer>[4],
    ) {
        super(context, env, definition, exportName, jurisdiction);
        this.#backupStorage = definition.backups;
    }

    public async lunoraReadFile(path: string, options: ContainerFileOptions = {}): Promise<Response> {
        const { container, release } = await this.lunoraAcquire("files.readFile");

        try {
            return releaseWhenRead(await this.files(container).readFile(path, options), release);
        } catch (error) {
            release();

            throw toSandboxError(error, this.label("files.readFile"));
        }
    }

    public async lunoraWriteFile(path: string, content: ContainerFileContent, options: ContainerFileOptions = {}): Promise<void> {
        await this.withContainer("files.writeFile", async (container) => this.files(container).writeFile(path, content as FileContent, options));
    }

    public async lunoraStat(path: string, options: ContainerFileOptions = {}): Promise<SandboxFileStat> {
        return this.withContainer("files.stat", async (container) => this.files(container).stat(path, options));
    }

    public async lunoraReadDirectory(path: string, options: ContainerFileOptions = {}): Promise<SandboxDirectoryEntry[]> {
        return this.withContainer("files.readDirectory", async (container) => this.files(container).readDirectory(path, options));
    }

    public async lunoraMkdir(path: string, options: ContainerFileOptions & { recursive?: boolean } = {}): Promise<void> {
        await this.withContainer("files.mkdir", async (container) => this.files(container).mkdir(path, options));
    }

    public async lunoraRename(source: string, destination: string, options: ContainerFileOptions = {}): Promise<void> {
        await this.withContainer("files.rename", async (container) => this.files(container).rename(source, destination, options));
    }

    public async lunoraRemove(path: string, options: ContainerFileOptions & { force?: boolean; recursive?: boolean } = {}): Promise<void> {
        await this.withContainer("files.remove", async (container) => this.files(container).remove(path, options));
    }

    public async lunoraBackup(directory: string, options: ContainerBackupOptions = {}): Promise<DirectoryBackupRecord> {
        const request = {
            dir: directory,
            ...(options.exclude === undefined ? {} : { exclude: [...options.exclude] }),
            ...(options.gitignore === undefined ? {} : { gitignore: options.gitignore }),
            ...(options.name === undefined ? {} : { name: options.name }),
        };

        return this.withContainer("backup", async (container) => this.backups(container).backup(request));
    }

    public async lunoraRestore(backup: DirectoryBackupRecord, options: { directory?: string } = {}): Promise<void> {
        const restoreOptions = options.directory === undefined ? {} : { dir: options.directory };

        await this.withContainer("restore", async (container) => this.backups(container).restore(backup, restoreOptions));
    }

    /** Needs no running container — it only deletes the object. */
    public async lunoraDeleteBackup(backup: DirectoryBackupRecord): Promise<void> {
        const container = this.ctx.container as HelperContainer | undefined;

        if (container === undefined) {
            throw new LunoraError("INTERNAL", `${this.label("deleteBackup")}: this Durable Object has no container binding`);
        }

        try {
            await this.backups(container).delete(backup);
        } catch (error) {
            throw toSandboxError(error, this.label("deleteBackup"));
        }
    }

    public async lunoraMount(request: ContainerMountRequest): Promise<void> {
        if (this.usingInterception) {
            // A mount registers its storage intercept after the container is
            // up, and the egress policy's catch-all — installed at start —
            // takes every hostname registered after it. The mount's traffic
            // would then hit the egress policy instead of the gateway.
            throw new LunoraError(
                "BAD_REQUEST",
                `${this.label("mount")}: bucket mounts cannot be combined with an egress policy (allowedHosts, deniedHosts, interceptHttps, outbound handlers or runtime egress controls) on the same container`,
            );
        }

        const source = {
            bucket: request.bucket,
            credentials: { type: "static" as const, ...this.mountCredentials(request) },
            endpoint: request.endpoint,
            region: request.region,
            type: "s3" as const,
        };

        const mountRequest = {
            access: request.access,
            mountPath: request.path,
            source,
            ...(request.keyPrefix === undefined ? {} : { keyPrefix: request.keyPrefix }),
            ...(request.s3fsOptions === undefined ? {} : { s3fsOptions: request.s3fsOptions }),
        };

        await this.withContainer("mount", async (container) => this.mounts(container).mount(mountRequest));
    }

    public async lunoraInspectMount(path: string): Promise<S3MountInspection> {
        return this.withContainer("inspectMount", async (container) => this.mounts(container).inspect(path));
    }

    public async lunoraUnmount(path: string): Promise<void> {
        await this.withContainer("unmount", async (container) => this.mounts(container).unmount(path));
    }

    /**
     * Route backup traffic to its gateway before the base installs the egress
     * policy's catch-all, which takes every hostname registered after it.
     * Without an egress policy there is no catch-all, and each backup or
     * restore registers its own route when it runs.
     */
    protected override async beforeContainerStart(): Promise<void> {
        await super.beforeContainerStart();

        const container = this.ctx.container as HelperContainer | undefined;

        if (this.#backupStorage !== undefined && this.usingInterception && container !== undefined) {
            await this.backups(container).intercept();
        }
    }

    /** Run one helper operation on the running container, translating sandbox errors. */
    private async withContainer<T>(operation: string, run: (container: HelperContainer) => Promise<T>): Promise<T> {
        const { container, release } = await this.lunoraAcquire(operation);

        try {
            return await run(container);
        } catch (error) {
            throw toSandboxError(error, this.label(operation));
        } finally {
            release();
        }
    }

    private files(container: HelperContainer): Files {
        this.#files ??= new Files(container);

        return this.#files;
    }

    /** One `DirectoryBackup` per instance: it runs one operation at a time per container, which only holds if every call shares it. */
    private backups(container: HelperContainer): DirectoryBackup {
        if (this.#backupStorage === undefined) {
            throw new LunoraError("BAD_REQUEST", `container "${this.lunoraName}": backups need \`backups: { bucket }\` in lunora/containers.ts`);
        }

        const { bucket } = this.#backupStorage;

        // The gateway reads the bucket off the same env; checked here so a
        // missing binding names the fix instead of failing inside the gateway.
        if (typeof (this.env as Record<string, { get?: unknown } | undefined>)[bucket]?.get !== "function") {
            throw new LunoraError(
                "INTERNAL",
                `container "${this.lunoraName}": backups.bucket "${bucket}" is not an R2 bucket binding on the Worker env — add an r2_buckets entry with binding "${bucket}" to wrangler.jsonc`,
            );
        }

        this.#backups ??= new DirectoryBackup(container, this.workerExport("DirectoryBackupGateway") as DirectoryBackupGatewayBinding, {
            binding: this.#backupStorage.bucket,
            ...(this.#backupStorage.prefix === undefined ? {} : { prefix: this.#backupStorage.prefix }),
        });

        return this.#backups;
    }

    private mounts(container: HelperContainer): S3Mount {
        this.#mounts ??= new S3Mount(container, this.workerExport("S3Gateway") as S3GatewayBinding);

        return this.#mounts;
    }

    /** A Worker entrypoint from `ctx.exports`, with the fix when the worker does not export it. */
    private workerExport(name: string): unknown {
        const binding = (this.ctx as { exports?: Record<string, unknown> }).exports?.[name];

        if (binding === undefined) {
            throw new LunoraError(
                "INTERNAL",
                `container "${this.lunoraName}": the worker does not export ${name}. Re-export the generated containers file from the worker entry (\`export * from "./lunora/_generated/containers.js"\`).`,
            );
        }

        return binding;
    }

    /** Resolve a mount's credentials from the Worker secrets they name. */
    private mountCredentials(request: ContainerMountRequest): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
        const secret = (name: string): string => {
            const value = (this.env as Record<string, unknown>)[name];

            if (typeof value !== "string" || value.length === 0) {
                throw new LunoraError(
                    "INTERNAL",
                    `${this.label("mount")}: credential secret "${name}" is not set on the Worker env — add it with \`wrangler secret put ${name}\` (or .dev.vars)`,
                );
            }

            return value;
        };
        const { accessKeyIdSecret, secretAccessKeySecret, sessionTokenSecret } = request.credentials;

        return {
            accessKeyId: secret(accessKeyIdSecret),
            secretAccessKey: secret(secretAccessKeySecret),
            ...(sessionTokenSecret === undefined ? {} : { sessionToken: secret(sessionTokenSecret) }),
        };
    }

    private label(operation: string): string {
        return `container "${this.lunoraName}": ${operation}()`;
    }
}

export default LunoraSandboxContainer;
