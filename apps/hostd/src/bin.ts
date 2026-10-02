import { runBin } from "./run-bin";

/**
 * `lunora-hostd` entry point. packem builds it to `dist/bin.mjs` and
 * `package.json#bin` points there; a Node single-executable build of the same
 * entry follows with plan 458 W7. `exitCode` rather than `process.exit()`, so
 * piped output is flushed before the process ends.
 */
process.exitCode = runBin(process.argv.slice(2), {
    stderr: (text) => process.stderr.write(text),
    stdout: (text) => process.stdout.write(text),
});
