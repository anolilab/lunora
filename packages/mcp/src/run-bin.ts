import { parseAgentsEnv } from "./agent-tools";
import type { LunoraMcpServerOptions } from "./server";
import { connectStdio } from "./server";

/**
 * Environment the `lunora-mcp` binary reads its configuration from. Modelled as
 * a plain bag so the entry logic is testable without mutating `process.env`.
 *
 * - `LUNORA_URL` (required) — base URL of the deployed Worker.
 * - `LUNORA_ADMIN_TOKEN` (required) — bearer token sent on every RPC. It must be the deployment's admin token: every tool depends on admin-gated introspection (`/_lunora/admin/*`), so a scoped/app token 403s (`ADMIN_FORBIDDEN`) on the first call. The read-only guarantee is enforced in-process via `LUNORA_MCP_ALLOW_WRITES` defaulting off — NOT by the token's scope.
 * - `LUNORA_MCP_ALLOW_WRITES` (optional) — set to `1`/`true`/`yes`/`on` to expose the mutation/action tools. Default: read-only (writes disabled).
 * - LUNORA_MCP_ALLOW_OBSERVABILITY (optional) — set to `1`/`true`/`yes`/`on` to expose the five `lunora_get_*` observability tools. They are read-only, but they return production log lines, request metadata and grouped error messages — user data that lands at the model provider — so they are off by default even though every tool already holds the admin bearer.
 * - `LUNORA_MCP_ALLOW_AGENTS` (optional) — set to `1`/`true`/`yes`/`on` to expose the `agent_<name>` tools. Default: agent tools disabled.
 * - `LUNORA_MCP_AGENTS` (optional) — `;`-separated `name:description` pairs (e.g. `"support:Support questions;billing:Billing help"`) selecting which agents to expose.
 * - `LUNORA_MCP_AGENT_TIMEOUT_MS` (optional) — wall-clock budget a single agent tool call awaits before returning a pending result.
 */
interface BinEnvironment {
    LUNORA_ADMIN_TOKEN?: string;
    LUNORA_MCP_AGENT_TIMEOUT_MS?: string;
    LUNORA_MCP_AGENTS?: string;
    LUNORA_MCP_ALLOW_AGENTS?: string;
    LUNORA_MCP_ALLOW_OBSERVABILITY?: string;
    LUNORA_MCP_ALLOW_WRITES?: string;
    LUNORA_URL?: string;
}

/** Truthy env values that enable a boolean flag. */
const ENABLED_ENV_VALUES = new Set(["1", "on", "true", "yes"]);

const isEnvEnabled = (value: string | undefined): boolean => value !== undefined && ENABLED_ENV_VALUES.has(value.trim().toLowerCase());

interface RunBinDependencies {
    /** Connects the MCP server over stdio; injectable for tests. Defaults to `connectStdio`. */
    connect?: (options: LunoraMcpServerOptions) => Promise<unknown>;
    /** Sink for diagnostics; defaults to `process.stderr.write`. */
    writeError?: (message: string) => void;
}

/**
 * Raised when the binary cannot start. `code` is the exit code the entry should
 * surface to the spawning MCP client; the message has already been written to
 * the error sink, so the caller only needs to `process.exit(code)`.
 */
class BinError extends Error {
    public readonly code: number;

    public constructor(message: string, code: number) {
        super(message);
        this.name = "BinError";
        this.code = code;
    }
}

/**
 * Validate the environment and start the stdio MCP server. Throws a `BinError`
 * (after writing the diagnostic) on missing config or startup failure, so the
 * thin `bin.ts` entry can translate it into a non-zero `process.exit`.
 *
 * Pure with respect to globals: all I/O goes through injected dependencies, so
 * the guard and startup paths are deterministically unit-testable.
 */
const runBin = async (environment: BinEnvironment, dependencies: RunBinDependencies = {}): Promise<void> => {
    const connect = dependencies.connect ?? connectStdio;
    const writeError =
        dependencies.writeError ??
        ((message: string): void => {
            process.stderr.write(message);
        });

    const url = environment.LUNORA_URL;

    if (url === undefined || url.length === 0) {
        writeError("lunora-mcp: LUNORA_URL environment variable is required\n");

        throw new BinError("LUNORA_URL environment variable is required", 1);
    }

    const token = environment.LUNORA_ADMIN_TOKEN;

    // Refused here rather than at the first 403: every tool reaches admin-gated
    // routes, so a tokenless server has no working surface at all.
    if (token === undefined || token.length === 0) {
        writeError("lunora-mcp: LUNORA_ADMIN_TOKEN environment variable is required (every tool reads admin-gated routes)\n");

        throw new BinError("LUNORA_ADMIN_TOKEN environment variable is required", 1);
    }

    // Parse the agent-timeout budget only when it's a positive finite number;
    // a malformed value falls through to the server-side default.
    const rawTimeout = Number(environment.LUNORA_MCP_AGENT_TIMEOUT_MS);
    const agentMaxWaitMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : undefined;

    try {
        await connect({
            agents: parseAgentsEnv(environment.LUNORA_MCP_AGENTS),
            allowAgents: isEnvEnabled(environment.LUNORA_MCP_ALLOW_AGENTS),
            allowObservability: isEnvEnabled(environment.LUNORA_MCP_ALLOW_OBSERVABILITY),
            allowWrites: isEnvEnabled(environment.LUNORA_MCP_ALLOW_WRITES),
            token,
            url,
            ...(agentMaxWaitMs === undefined ? {} : { agentMaxWaitMs }),
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        writeError(`lunora-mcp: failed to start — ${message}\n`);

        throw new BinError(`failed to start — ${message}`, 1);
    }
};

export type { BinEnvironment, RunBinDependencies };
export { BinError, runBin };
