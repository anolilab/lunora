import { runCli } from "@lunora/cli";

/**
 * `lunora` binary entry point. The umbrella package owns the `lunora` bin and
 * delegates to `@lunora/cli`'s `runCli`, so installing `lunora` alone gives you
 * the full CLI (`init`, `dev`, `deploy`, `codegen`, `run`, `reset`, `migrate`)
 * without a separate `@lunora/cli` dependency. packem builds this to
 * `dist/bin.mjs` with a `#!/usr/bin/env node` shebang prepended.
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
