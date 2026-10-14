/**
 * Stream a project's local dev container logs into the dev terminal.
 *
 * During `lunora dev` / `vite dev`, wrangler builds and runs each declared
 * container locally via Docker, naming the image `cloudflare-dev/<class>:<id>`
 * (the lowercased Durable Object class name — see wrangler's
 * `getDevContainerImageName`). Wrangler forwards the *worker's* console output,
 * but never the container process's own stdout/stderr, so a developer can't see
 * what their container is doing. This module attaches to those Docker log
 * streams with `dockerode` and emits each line back to the caller, tagged with
 * the friendly `lunora/containers.ts` export name.
 *
 * Shared by the CLI `dev` command and the Vite plugin (`@lunora/config` is the
 * common layer), so both surfaces render container output identically. The
 * `dockerode` import is lazy: a project with no containers — the common case —
 * never loads it, and a missing/stopped Docker engine degrades to a single
 * `onUnavailable` notice rather than breaking dev.
 */
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Prefix of every image wrangler builds for a local dev container (`cloudflare-dev/<class>:<id>`). */
const DEV_CONTAINER_IMAGE_PREFIX = "cloudflare-dev/";

/** How often to poll Docker for newly-started (or replaced) dev containers, in ms. */
const DEFAULT_POLL_INTERVAL_MS = 1500;

/** Severity a container output line is surfaced at: `stderr` → `error`, `stdout` → `info`. */
type ContainerLogLevel = "error" | "info";

/** One declared container to follow, identified by the names codegen lifts from `defineContainer`. */
interface ContainerLogSource {
    /** Generated Durable Object class name, e.g. `TranscoderContainer`. Wrangler's dev image is `cloudflare-dev/<lowercased>`. */
    className: string;
    /** The `lunora/containers.ts` export name, e.g. `transcoder` — used as the display tag. */
    exportName: string;
}

/** A single line of container output handed back to the caller. */
interface ContainerLogLine {
    /** `"error"` for the container's stderr, `"info"` for its stdout. */
    level: ContainerLogLevel;
    /** The container's export name (`transcoder`), for tagging the line. */
    name: string;
    /** One output line, with the trailing newline (and any `\r`) stripped. */
    text: string;
}

interface ContainerLogStreamOptions {
    /** The declared containers to follow. An empty list yields an inert handle. */
    containers: ReadonlyArray<ContainerLogSource>;
    /** Injected Docker client — defaults to a real lazily-imported `dockerode` instance. Tests pass a stub. */
    docker?: DockerLike;
    /** Called once per container output line. */
    onLine: (line: ContainerLogLine) => void;
    /** Called once when the Docker engine can't be reached (re-armed after it recovers). Defaults to silent. */
    onUnavailable?: (message: string) => void;
    /** Poll interval override, in ms. */
    pollIntervalMs?: number;
}

/** Handle controlling a running log stream. */
interface ContainerLogStreamHandle {
    /** Stop polling and tear down every attached log stream. Idempotent. */
    close: () => void;
}

/** The minimal structural slice of a `dockerode` log stream this module consumes. */
interface DockerLogStream {
    destroy: () => void;
    on: (event: "data" | "end" | "error", listener: (chunk?: Buffer) => void) => void;
}

/** The minimal structural slice of a `dockerode` instance this module consumes. */
interface DockerLike {
    getContainer: (id: string) => {
        logs: (options: { follow: true; stderr: true; stdout: true; tail: "all"; timestamps: false }) => Promise<DockerLogStream>;
    };
    listContainers: (options: { filters: { status: ["running"] } }) => Promise<{ Id: string; Image: string }[]>;
    modem: { demuxStream: (stream: DockerLogStream, stdout: Writable, stderr: Writable) => void };
}

/** Lazily construct a real `dockerode` client (default socket / `DOCKER_HOST`). Kept out of the module's static import graph. */
const createDefaultDocker = async (): Promise<DockerLike> => {
    const { default: Dockerode } = await import("dockerode");

    return new Dockerode() as unknown as DockerLike;
};

/** Extract the lowercased class segment from a `cloudflare-dev/<class>:<id>` image, or `undefined` for any other image. */
const classFromImage = (image: string): string | undefined => {
    if (!image.startsWith(DEV_CONTAINER_IMAGE_PREFIX)) {
        return undefined;
    }

    const [segment] = image.slice(DEV_CONTAINER_IMAGE_PREFIX.length).split(":");

    return segment !== undefined && segment.length > 0 ? segment : undefined;
};

/**
 * A `Writable` that buffers bytes and emits one trimmed line per `\n`. The
 * trailing partial is held until the next chunk and flushed on `final`, so a
 * line split across two Docker frames is never torn.
 */
const lineBufferWritable = (emit: (text: string) => void): Writable => {
    // Decode incrementally so a multi-byte UTF-8 character split across two
    // Docker frames is reassembled rather than turned into replacement chars.
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    const flushLine = (line: string): void => {
        emit(line.endsWith("\r") ? line.slice(0, -1) : line);
    };

    return new Writable({
        final(callback) {
            // Flush any bytes the decoder is still holding, then the partial line.
            buffer += decoder.end();

            if (buffer.length > 0) {
                flushLine(buffer);
                buffer = "";
            }

            callback();
        },
        write(chunk: Buffer, _encoding, callback) {
            buffer += decoder.write(chunk);

            const lines = buffer.split("\n");

            buffer = lines.pop() ?? "";

            for (const line of lines) {
                flushLine(line);
            }

            callback();
        },
    });
};

/**
 * Follow the local Docker logs of every declared container, emitting each output
 * line through `onLine` tagged with its export name. Polls for containers (they
 * start lazily on first request and may be replaced on restart), attaches once
 * per container id, and drops streams whose container has gone. Returns
 * immediately with a `close()` handle; all work happens asynchronously.
 */
const streamContainerLogs = (options: ContainerLogStreamOptions): ContainerLogStreamHandle => {
    // Map the lowercased class name (the image segment wrangler uses) back to the
    // friendly export name we tag lines with.
    const classToExport = new Map(options.containers.map((source) => [source.className.toLowerCase(), source.exportName]));

    if (classToExport.size === 0) {
        return { close: () => {} };
    }

    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const attached = new Map<string, DockerLogStream>();

    let closed = false;
    let unavailableNotified = false;
    let timer: NodeJS.Timeout | undefined;
    let dockerPromise: Promise<DockerLike> | undefined;

    const getDocker = async (): Promise<DockerLike> => {
        dockerPromise ??= options.docker ? Promise.resolve(options.docker) : createDefaultDocker();

        return dockerPromise;
    };

    const attach = async (docker: DockerLike, id: string, exportName: string): Promise<void> => {
        try {
            const stream = await docker.getContainer(id).logs({ follow: true, stderr: true, stdout: true, tail: "all", timestamps: false });

            if (closed) {
                stream.destroy();

                return;
            }

            const stdout = lineBufferWritable((text) => {
                options.onLine({ level: "info", name: exportName, text });
            });
            const stderr = lineBufferWritable((text) => {
                options.onLine({ level: "error", name: exportName, text });
            });

            docker.modem.demuxStream(stream, stdout, stderr);

            stream.on("end", () => {
                stdout.end();
                stderr.end();
                attached.delete(id);
            });
            stream.on("error", () => {
                attached.delete(id);
            });

            attached.set(id, stream);
        } catch {
            // Transient — the container may have stopped between listing and
            // attaching; the next poll retries.
        }
    };

    // List the running dev containers, or `undefined` when Docker is unreachable
    // (notified once). Resets the notified flag on a successful call.
    const listRunning = async (): Promise<{ Id: string; Image: string }[] | undefined> => {
        try {
            const docker = await getDocker();
            const running = await docker.listContainers({ filters: { status: ["running"] } });

            unavailableNotified = false;

            return running;
        } catch (error: unknown) {
            if (!unavailableNotified) {
                unavailableNotified = true;
                options.onUnavailable?.(error instanceof Error ? error.message : String(error));
            }

            return undefined;
        }
    };

    // Attach to newly-seen declared containers and drop streams whose container
    // has gone. `live` is the set of ids that matched a declared container.
    const reconcile = async (docker: DockerLike, running: { Id: string; Image: string }[]): Promise<void> => {
        const live = new Set<string>();

        for (const summary of running) {
            const className = classFromImage(summary.Image);
            const exportName = className === undefined ? undefined : classToExport.get(className);

            if (exportName === undefined) {
                continue;
            }

            live.add(summary.Id);

            if (!attached.has(summary.Id)) {
                // eslint-disable-next-line no-await-in-loop -- attach sequentially; the set of new containers per tick is tiny.
                await attach(docker, summary.Id, exportName);
            }
        }

        for (const [id, stream] of attached) {
            if (!live.has(id)) {
                stream.destroy();
                attached.delete(id);
            }
        }
    };

    const poll = async (): Promise<void> => {
        if (closed) {
            return;
        }

        const running = await listRunning();

        if (running === undefined) {
            return;
        }

        // `attach` re-checks `closed` after its own await, so a `close()` that
        // lands mid-poll still tears every new stream down.
        await reconcile(await getDocker(), running);
    };

    // Poll on a fixed interval with an in-flight guard so a slow poll never
    // overlaps the next tick. The chain ends in `.catch` so a stray rejection is
    // swallowed (each poll already handles its own errors) and never floats.
    let polling = false;

    const onTick = (): void => {
        if (polling || closed) {
            return;
        }

        polling = true;
        poll()
            .finally(() => {
                polling = false;
            })
            .catch(() => undefined);
    };

    timer = setInterval(onTick, interval);
    timer.unref();
    onTick();

    return {
        close: () => {
            closed = true;

            if (timer) {
                clearInterval(timer);
                timer = undefined;
            }

            for (const [id, stream] of attached) {
                stream.destroy();
                attached.delete(id);
            }
        },
    };
};

export type { ContainerLogLevel, ContainerLogLine, ContainerLogSource, ContainerLogStreamHandle, ContainerLogStreamOptions, DockerLike };
export { streamContainerLogs };
