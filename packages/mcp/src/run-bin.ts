import type { LunoraMcpServerOptions } from "./server";
import { connectStdio } from "./server";

/**
 * Environment the `lunora-mcp` binary reads its configuration from. Modelled as
 * a plain bag so the entry logic is testable without mutating `process.env`.
 *
 * - `LUNORA_URL` (required) — base URL of the deployed Worker.
 * - `LUNORA_ADMIN_TOKEN` (optional) — bearer token sent on every RPC.
 */
interface BinEnvironment {
    LUNORA_ADMIN_TOKEN?: string;
    LUNORA_URL?: string;
}

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

    try {
        await connect({ token: environment.LUNORA_ADMIN_TOKEN, url });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        writeError(`lunora-mcp: failed to start — ${message}\n`);

        throw new BinError(`failed to start — ${message}`, 1);
    }
};

export type { BinEnvironment, RunBinDependencies };
export { BinError, runBin };
