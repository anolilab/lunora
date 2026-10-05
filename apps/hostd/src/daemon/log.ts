/**
 * The daemon's own log: one line per event on stderr, which systemd hands to
 * the journal. Never given a token, a key or a bucket credential — callers
 * log ids, paths and outcomes only.
 */

type LogLevel = "error" | "info" | "warn";

interface Logger {
    error: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
}

/** A logger writing `level: message` lines to `write` (stderr by default). */
const createLogger = (write: (line: string) => void = (line) => process.stderr.write(line)): Logger => {
    const at =
        (level: LogLevel) =>
        (message: string): void => {
            write(`lunora-hostd ${level}: ${message}\n`);
        };

    return { error: at("error"), info: at("info"), warn: at("warn") };
};

/** A logger that drops everything, for tests that do not inspect the log. */
const silentLogger: Logger = { error: () => undefined, info: () => undefined, warn: () => undefined };

export type { Logger };
export { createLogger, silentLogger };
