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
import { readLiveDevServerState } from "@lunora/config";
import { resolveAdminToken } from "@lunora/config/studio-host";
import type { LocalDeployment, LocalMcpServerOptions } from "@lunora/mcp";
import { connectLocalStdio } from "@lunora/mcp";

import { devTools } from "./dev-tools";

interface McpServeOptions {
    /** Expose the deployment write tools (mutations/actions). Default: read-only. */
    allowWrites?: boolean;
    /** The project directory to serve. */
    cwd: string;
    /** Docs site origin backing the documentation tools. */
    docsUrl?: string;
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
    onclose?: () => void;
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
): Promise<McpServeResult> => {
    const writeError =
        options.writeError ??
        ((message: string): void => {
            process.stderr.write(message);
        });

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

export type { ClosableServer, McpServeOptions, McpServeResult };
export { isLoopbackUrl, resolveDeployment, runMcpServe };
