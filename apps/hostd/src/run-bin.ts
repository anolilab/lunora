import { createRequire } from "node:module";

/** Where the binary writes; injected so tests need no real process streams. */
interface BinOutput {
    stderr: (text: string) => void;
    stdout: (text: string) => void;
}

const HELP = `lunora-hostd — runs Lunora Cloud fleets on your own server.

Usage:
  lunora-hostd --version   Print the version
  lunora-hostd --help      Print this help

Enrolment and the daemon itself (enrol, run) are not implemented yet; they
arrive with plan 458 W4.
`;

/** The package version, read from the manifest next to `dist/` (or `src/` in tests). */
const readVersion = (): string => (createRequire(import.meta.url)("../package.json") as { version: string }).version;

/**
 * Run `lunora-hostd` with the arguments after the executable and script.
 * Supports only `--version` and `--help` today; anything else exits non-zero
 * rather than pretending to be a daemon.
 * @returns the process exit code
 */
const runBin = (argv: ReadonlyArray<string>, output: BinOutput): number => {
    const [command] = argv;

    if (argv.length === 1 && (command === "--version" || command === "-v")) {
        output.stdout(`${readVersion()}\n`);

        return 0;
    }

    if (argv.length === 1 && (command === "--help" || command === "-h")) {
        output.stdout(HELP);

        return 0;
    }

    if (argv.length === 0) {
        output.stderr(HELP);

        return 1;
    }

    // The arguments are deliberately not echoed: `enrol --token …` carries a secret.
    output.stderr("lunora-hostd: not implemented yet: enrol/run arrive with plan 458 W4\nRun `lunora-hostd --help` for what this build supports.\n");

    return 1;
};

export type { BinOutput };
export { runBin };
