import { runBin } from "./run-bin";

/**
 * `lunora-hostd` entry point. packem builds it to `dist/bin.mjs` and
 * `package.json#bin` points there; `scripts/build-sea.mjs` bundles the same
 * entry into the single executable a box runs. `exitCode` rather than
 * `process.exit()` for the short commands, so piped output is flushed first.
 */
const argv = process.argv.slice(2);

const main = async (): Promise<void> => {
    const code = await runBin(argv, {
        stderr: (text) => process.stderr.write(text),
        stdout: (text) => process.stdout.write(text),
    });

    process.exitCode = code;

    if (argv[0] === "run") {
        // eslint-disable-next-line unicorn/no-process-exit -- the daemon must end with its session (systemd restarts it, after an upgrade into the new binary) even while a socket or timer lingers
        process.exit(code);
    }
};

// eslint-disable-next-line unicorn/prefer-top-level-await -- the single executable runs this bundle as CommonJS, which has no top-level await
main().catch((error: unknown) => {
    process.stderr.write(`lunora-hostd: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
