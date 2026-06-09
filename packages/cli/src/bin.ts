import { runCli } from "./cli";

/**
 * `cirrus` binary entry point. packem builds this to `dist/bin.mjs` (with a
 * `#!/usr/bin/env node` shebang prepended) and `package.json#bin` points at it,
 * so the published CLI runs compiled JS — no TypeScript loader needed at runtime.
 */
try {
    const code = await runCli();

    // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: propagate the resolved exit code to the shell
    process.exit(code);
} catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: a top-level failure must exit non-zero
    process.exit(1);
}
