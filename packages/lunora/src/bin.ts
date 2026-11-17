import { readFileSync } from "node:fs";

/**
 * `lunora` binary entry point. The umbrella package owns the `lunora` bin and
 * delegates to `@lunora/cli`'s `runCli`, so installing `lunora` alone gives you
 * the full CLI (`init`, `dev`, `deploy`, `codegen`, `run`, `reset`, `migrate`)
 * without a separate `@lunora/cli` dependency. packem builds this to
 * `dist/bin.mjs` with a `#!/usr/bin/env node` shebang prepended.
 *
 * Mirrors `@lunora/cli`'s own bin: only `node:` imports at the top, so a bare
 * `--version` / `-V` prints `@lunora/cli`'s version (what `runCli` reports)
 * straight from its manifest, and everything else loads `@lunora/cli/cli` on
 * demand — not the root entry, which re-exports every command handler
 * (ts-morph, codegen, …) and more than doubles startup.
 */
const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    const { version } = JSON.parse(readFileSync(new URL(import.meta.resolve("@lunora/cli/package.json")), "utf8")) as { version: string };

    process.stdout.write(`${version}\n`);
} else {
    try {
        const { runCli } = await import("@lunora/cli/cli");
        const code = await runCli();

        // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: propagate the resolved exit code to the shell
        process.exit(code);
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: a top-level failure must exit non-zero
        process.exit(1);
    }
}
