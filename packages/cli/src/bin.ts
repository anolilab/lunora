import { readFileSync } from "node:fs";

/**
 * `lunora` binary entry point. packem builds this to `dist/bin.mjs` (with a
 * `#!/usr/bin/env node` shebang prepended) and `package.json#bin` points at it,
 * so the published CLI runs compiled JS — no TypeScript loader needed at runtime.
 *
 * Only `node:` imports at the top: a bare `lunora --version` / `-V` answers from
 * `package.json` without evaluating the command framework, and everything else
 * loads `./cli` on demand. A static import of it would be hoisted and paid on
 * the version path too. (`bin.ts` sits at the `src/` root and `bin.mjs` at the
 * `dist/` root, so `../package.json` is the package manifest either way.)
 */
const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

    process.stdout.write(`${version}\n`);
} else {
    try {
        const { runCli } = await import("./cli");
        const code = await runCli();

        // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: propagate the resolved exit code to the shell
        process.exit(code);
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        // eslint-disable-next-line unicorn/no-process-exit -- CLI entrypoint: a top-level failure must exit non-zero
        process.exit(1);
    }
}
