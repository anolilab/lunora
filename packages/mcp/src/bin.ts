import { connectStdio } from "./server";

/**
 * `lunora-mcp` entry point. MCP clients spawn this binary and speak JSON-RPC
 * over stdio. Configuration comes from the environment so the spawn config
 * stays a plain `{ command, env }`:
 *
 * - `LUNORA_URL` (required) — base URL of the deployed Worker.
 * - `LUNORA_ADMIN_TOKEN` (optional) — bearer token sent on every RPC.
 */
const url = process.env.LUNORA_URL;

if (url === undefined || url.length === 0) {
    process.stderr.write("lunora-mcp: LUNORA_URL environment variable is required\n");
    // eslint-disable-next-line unicorn/no-process-exit -- this is the CLI binary entry; a non-zero exit is the correct failure signal to the spawning MCP client
    process.exit(1);
}

try {
    await connectStdio({ token: process.env.LUNORA_ADMIN_TOKEN, url });
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`lunora-mcp: failed to start — ${message}\n`);
    // eslint-disable-next-line unicorn/no-process-exit -- CLI binary: surface a startup failure as a non-zero exit code
    process.exit(1);
}
