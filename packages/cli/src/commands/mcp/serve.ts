/**
 * `lunora mcp serve` — the stdio MCP server an editor spawns for this project.
 *
 * The design goal is that its config has no knobs. An MCP client entry is
 * `{"command": "lunora", "args": ["mcp", "serve"]}` and nothing else: the server
 * discovers the running dev server from `.lunora/dev.json` and the admin token
 * from `.dev.vars`, so there is no URL to keep in sync and no token pasted into
 * a config file that then gets committed.
 *
 * Discovery re-runs on every tool call rather than once at startup, because an
 * editor spawns this process when the project opens — routinely before
 * `lunora dev` is running — and keeps it alive across every restart afterwards.
 */
import type { FSWatcher } from "node:fs";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";

import { readLiveDevServerState } from "@lunora/config";
import { resolveAdminToken } from "@lunora/config/studio-host";
import type { FunctionMcpServerOptions, LocalDeployment, LocalMcpServerOptions } from "@lunora/mcp";
import { connectFunctionStdio, connectLocalStdio } from "@lunora/mcp";

import { devTools } from "./dev-tools";

interface McpServeOptions {
    /** Expose the deployment write tools (mutations/actions). Default: read-only. */
    allowWrites?: boolean;

    /** The project directory to serve. */
    cwd: string;
    /** Docs site origin backing the documentation tools. */
    docsUrl?: string;

    /**
     * Serve one tool per function of this app instead of the generic deployment tools.
     * Needs `lunora/_generated/openrpc.json`, which codegen writes for `apiSpec: "openrpc"`.
     */
    functions?: boolean;
    /** Omit the documentation tools. */
    noDocs?: boolean;
    /** Bearer token override; defaults to the project's resolved admin token. */
    token?: string;
    /** Deployment URL override; defaults to the running dev server's. */
    url?: string;
    /** Version reported in the MCP handshake. */
    version: string;
    /** Diagnostics sink. Defaults to stderr — see {@link runMcpServe}. */
    writeError?: (message: string) => void;
}

interface McpServeResult {
    code: number;
    /** The deployment resolved at startup, for the diagnostic line and tests. */
    deployment: LocalDeployment | undefined;
}

/**
 * The part of a connected MCP `Server` this command needs: a close signal.
 *
 * Typing the seam this narrowly (rather than `unknown`) is what lets
 * {@link waitForClose} skip the runtime shape check and the cast — and lets a
 * test drive the blocking path with a stub.
 */
interface ClosableServer {
    /** Closes the server and releases what it holds, such as a cached client's socket. */
    close?: () => Promise<void>;
    onclose?: () => void;
    /** Tells the connected client its tool list changed. Only a function server has one to change. */
    sendToolListChanged?: () => Promise<void>;
}

/** A document with no functions: what the server serves once the document has been removed. */
const NO_FUNCTIONS: unknown = { methods: [], openrpc: "1.3.2" };

const isMissing = (error: unknown): boolean => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

/** The OpenRPC document as it was last read, with the mtime it was read at. */
interface LoadedSpec {
    mtimeMs: number;
    spec: unknown;
}

/** Hostnames that are unambiguously this machine. */
const LOOPBACK_HOST_NAMES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/** True when `url` points at this machine — where a locally-discovered token belongs. */
const isLoopbackUrl = (url: string): boolean => {
    try {
        const { hostname } = new URL(url);

        // `new URL` keeps IPv6 literals bracketed.
        return LOOPBACK_HOST_NAMES.has(hostname.startsWith("[") ? hostname.slice(1, -1) : hostname);
    } catch {
        return false;
    }
};

/**
 * Resolve the deployment the tools talk to: an explicit `--url`, else the dev
 * server currently recorded for this project. `undefined` means "nothing
 * running right now" — the deployment tools stay advertised and explain
 * themselves when called.
 *
 * The token is deliberately NOT carried to a remote host. `LUNORA_ADMIN_TOKEN`
 * is discovered from the environment or `.dev.vars` and is meant for the local
 * dev server; pairing the two by default would ship the project's admin bearer
 * to an arbitrary origin — including over plain HTTP — on the strength of one
 * flag in a committed `.mcp.json`. Pass `--token` to send one deliberately.
 *
 * The loopback check applies to the resolved URL, WHICHEVER SOURCE it came
 * from. `.lunora/dev.json` is an on-disk record this command reads without
 * being asked to — written by whatever last ran in the checkout, and carried
 * along by anything that copies a project directory — so gating only the
 * explicit `--url` left the un-asked-for source as the trusted one.
 */
const resolveDeployment = (options: McpServeOptions): LocalDeployment | undefined => {
    const url = options.url ?? readLiveDevServerState(options.cwd)?.url;

    if (url === undefined || url.length === 0) {
        return undefined;
    }

    if (options.token !== undefined && options.token.length > 0) {
        return { token: options.token, url };
    }

    if (!isLoopbackUrl(url)) {
        return { url };
    }

    const token = resolveAdminToken(options.cwd);

    return token === undefined || token.length === 0 ? { url } : { token, url };
};

/**
 * Block until the connected server closes — i.e. until the MCP client
 * disconnects and the stdio transport tears down.
 *
 * This is load-bearing. The command framework exits the process with whatever
 * code the handler returns, so resolving as soon as the transport is *connected*
 * would kill the server before it answered its first request.
 */
const waitForClose = async (closable: ClosableServer): Promise<void> => {
    await new Promise<void>((resolve) => {
        const done = (): void => {
            resolve();
        };

        /* eslint-disable no-param-reassign -- registering the close callback IS the point: the SDK's `Server` signals teardown through an assignable `onclose` property. */
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- `Server` is not an EventTarget, so there is no addEventListener to prefer.
        closable.onclose = done;
        /* eslint-enable no-param-reassign */

        // Belt and braces: a client that simply closes the pipe (rather than
        // sending a shutdown) ends stdin without the transport reporting a
        // close, and an unsettled promise there turns a clean exit into Node's
        // "unsettled top-level await" warning and a non-zero exit code.
        process.stdin.once("close", done);
        process.stdin.once("end", done);
    });
};

/**
 * The one-line startup diagnostic. Both branches tell the user what to do next:
 * with nothing running the deployment tools are present but inert, and without
 * an admin token they are present but will be refused.
 */
const describeStartup = (deployment: LocalDeployment | undefined): string => {
    if (deployment === undefined) {
        return "lunora mcp serve: ready (documentation tools). No dev server running yet — start `lunora dev` and the deployment tools start working, no restart needed.\n";
    }

    if (deployment.token !== undefined) {
        return `lunora mcp serve: ready — deployment at ${deployment.url}\n`;
    }

    const withheld = !isLoopbackUrl(deployment.url);
    const why = withheld
        ? "the project's admin token was NOT sent to this non-local url; pass --token to authenticate deliberately"
        : "no LUNORA_ADMIN_TOKEN in the environment or .dev.vars; the deployment tools will be refused until one is set";

    return `lunora mcp serve: ready — deployment at ${deployment.url} (${why})\n`;
};

/** Diagnostics go to stderr: stdout is the MCP wire. */
const writeToStderr = (message: string): void => {
    process.stderr.write(message);
};

/**
 * `--functions`: one MCP tool per function of this app, from the OpenRPC document
 * codegen wrote to `lunora/_generated/openrpc.json`.
 *
 * Identity is the caller's, so the bearer is the explicit `--token` and nothing
 * else. The project's admin token is never used here: these tools run as the
 * caller, and handing them the admin bearer would turn each one into an admin call.
 */
const serveFunctions = async (options: McpServeOptions, connect: (options: FunctionMcpServerOptions) => Promise<ClosableServer>): Promise<McpServeResult> => {
    const writeError = options.writeError ?? writeToStderr;
    const specPath = join(options.cwd, "lunora", "_generated", "openrpc.json");

    // Resolved on every call, not once: the editor starts this process before `lunora dev`
    // is running, and the server keeps the URL current when the dev server moves.
    const deploymentUrl = (): string | undefined => options.url ?? readLiveDevServerState(options.cwd)?.url;

    // A document that exists but cannot be parsed is reported once per modification time, so a
    // file that stays broken is not repeated on every `tools/list`.
    let reportedMtime: number | undefined;
    const reloadFailed = (error: unknown): void => {
        writeError(`lunora mcp serve --functions: kept the last tool list — the rewritten document did not load: ${String(error)}\n`);
    };

    // Codegen rewrites the file in place, so the tools follow it: each `tools/list` and `tools/call`
    // re-reads it when its mtime has moved. A half-written rewrite fails to parse, and the last
    // complete document keeps serving. A missing file means no functions yet (the editor may start
    // before codegen has run) or that OpenRPC was turned off, so the tools are removed until it exists.
    let loaded: LoadedSpec = { mtimeMs: -1, spec: NO_FUNCTIONS };
    const specNow = (): unknown => {
        let mtimeMs: number;

        try {
            mtimeMs = statSync(specPath).mtimeMs;
        } catch (error: unknown) {
            if (!isMissing(error)) {
                reloadFailed(error);
            } else if (loaded.spec !== NO_FUNCTIONS) {
                loaded = { mtimeMs: -1, spec: NO_FUNCTIONS };
            }

            return loaded.spec;
        }

        if (mtimeMs !== loaded.mtimeMs) {
            try {
                loaded = { mtimeMs, spec: JSON.parse(readFileSync(specPath, "utf8")) as unknown };
            } catch (error: unknown) {
                if (reportedMtime !== mtimeMs) {
                    reportedMtime = mtimeMs;
                    reloadFailed(error);
                }
            }
        }

        return loaded.spec;
    };

    let server: ClosableServer;

    try {
        server = await connect({
            allowWrites: options.allowWrites === true,
            onReloadError: reloadFailed,
            openRpcSpec: specNow,
            url: deploymentUrl,
            version: options.version,
            ...(options.token === undefined || options.token.length === 0 ? {} : { token: options.token }),
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        writeError(`lunora mcp serve --functions: failed to start — ${message}\n`);

        return { code: 1, deployment: undefined };
    }

    const withoutBearer = options.token === undefined || options.token.length === 0;
    const url = deploymentUrl();
    const target = url === undefined || url.length === 0 ? "no deployment yet (start `lunora dev` or pass --url; calls fail until one runs)" : url;

    const awaitingDocument = existsSync(specPath) ? "" : " (no openrpc.json yet: run `lunora codegen --api-spec openrpc`; the functions appear once it exists)";

    writeError(
        `lunora mcp serve --functions: ready — ${target}${withoutBearer ? " (no --token: only public functions answer, and writes are refused)" : ""}${awaitingDocument}\n`,
    );

    // The editor keeps its tool list until it hears otherwise, so announce each change to the document,
    // including its arrival on a fresh checkout. The watch sits on the nearest directory that exists, and
    // moves down to `_generated` once codegen creates it. A watch that cannot start or fails costs only
    // those announcements: each call still reads the file.
    const generatedDirectory = dirname(specPath);
    const watchFailed = (error: unknown): void => {
        writeError(`lunora mcp serve --functions: the tool list will not be announced on a change — ${String(error)}\n`);
    };
    const watchTarget = (): string => {
        if (existsSync(generatedDirectory)) {
            return generatedDirectory;
        }

        const lunoraDirectory = dirname(generatedDirectory);

        return existsSync(lunoraDirectory) ? lunoraDirectory : options.cwd;
    };
    let documentPresent = existsSync(specPath);
    let watched: { directory: string; watcher: FSWatcher } | undefined;
    const watchChanges = (): void => {
        const directory = watchTarget();

        if (watched?.directory === directory) {
            return;
        }

        watched?.watcher.close();
        watched = undefined;

        try {
            const watcher = watch(directory, (_event, fileName) => {
                const present = existsSync(specPath);
                const changed = fileName === "openrpc.json" || present !== documentPresent;

                documentPresent = present;
                watchChanges();

                if (changed) {
                    server.sendToolListChanged?.().catch((error: unknown) => {
                        writeError(`lunora mcp serve --functions: could not announce the tool list change — ${String(error)}\n`);
                    });
                }
            });

            watcher.on("error", watchFailed);
            watched = { directory, watcher };
        } catch (error: unknown) {
            watchFailed(error);
        }
    };

    watchChanges();

    try {
        await waitForClose(server);
    } finally {
        watched?.watcher.close();

        // Closing the server releases its cached client, which may hold a stream's socket open.
        try {
            await server.close?.();
        } catch (error: unknown) {
            writeError(`lunora mcp serve --functions: could not close the server — ${String(error)}\n`);
        }
    }

    return { code: 0, deployment: undefined };
};

/**
 * Start the stdio server and serve until the client disconnects.
 *
 * Diagnostics go to **stderr**, never stdout: stdout is the MCP wire, and a
 * single stray line there corrupts the JSON-RPC framing and takes the session
 * down. That is also why this path never touches the CLI logger.
 */
const runMcpServe = async (
    options: McpServeOptions,
    connect: (options: LocalMcpServerOptions) => Promise<ClosableServer> = connectLocalStdio,
    connectFunctions: (options: FunctionMcpServerOptions) => Promise<ClosableServer> = connectFunctionStdio,
): Promise<McpServeResult> => {
    if (options.functions === true) {
        return serveFunctions(options, connectFunctions);
    }

    const writeError = options.writeError ?? writeToStderr;

    let server: ClosableServer;

    try {
        server = await connect({
            allowWrites: options.allowWrites === true,
            deployment: () => resolveDeployment(options),
            docs: options.noDocs === true ? false : { ...(options.docsUrl === undefined ? {} : { baseUrl: options.docsUrl }) },
            extraTools: devTools(options.cwd),
            version: options.version,
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        writeError(`lunora mcp serve: failed to start — ${message}\n`);

        return { code: 1, deployment: undefined };
    }

    const deployment = resolveDeployment(options);

    writeError(describeStartup(deployment));

    await waitForClose(server);

    return { code: 0, deployment };
};

export type { ClosableServer };
export { resolveDeployment, runMcpServe };
