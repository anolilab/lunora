import { BinError, runBin } from "./run-bin";

/**
 * `lunora-mcp` entry point. MCP clients spawn this binary and speak JSON-RPC
 * over stdio. Configuration comes from the environment so the spawn config
 * stays a plain `{ command, env }`:
 *
 * - `LUNORA_URL` (required) — base URL of the deployed Worker.
 * - `LUNORA_ADMIN_TOKEN` (optional) — bearer token sent on every RPC.
 *
 * The validation/startup logic lives in `runBin` (testable in isolation); this
 * entry is just the top-level-await shim that maps a `BinError` onto a non-zero
 * exit code — the correct failure signal to the spawning MCP client.
 */
try {
    await runBin(process.env);
} catch (error: unknown) {
    // eslint-disable-next-line unicorn/no-process-exit -- CLI binary entry: a non-zero exit is the correct failure signal to the spawning MCP client
    process.exit(error instanceof BinError ? error.code : 1);
}
