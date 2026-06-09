import { connectStdio } from "./server";

/**
 * `cirrus-mcp` entry point. MCP clients spawn this binary and speak JSON-RPC
 * over stdio. Configuration comes from the environment so the spawn config
 * stays a plain `{ command, env }`:
 *
 * - `CIRRUS_URL` (required) — base URL of the deployed Worker.
 * - `CIRRUS_ADMIN_TOKEN` (optional) — bearer token sent on every RPC.
 */
const url = process.env.CIRRUS_URL;

if (url === undefined || url.length === 0) {
    process.stderr.write("cirrus-mcp: CIRRUS_URL environment variable is required\n");
    // eslint-disable-next-line unicorn/no-process-exit -- this is the CLI binary entry; a non-zero exit is the correct failure signal to the spawning MCP client
    process.exit(1);
}

try {
    await connectStdio({ token: process.env.CIRRUS_ADMIN_TOKEN, url });
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`cirrus-mcp: failed to start — ${message}\n`);
    // eslint-disable-next-line unicorn/no-process-exit -- CLI binary: surface a startup failure as a non-zero exit code
    process.exit(1);
}
