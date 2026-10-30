const SIGNALS = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
] as const;

const cleanups = new Set<() => void>();
// eslint-disable-next-line unicorn/no-process-exit -- an interrupted CLI exits once its cleanup is done
const exitNow = (code: number): void => process.exit(code);
let exitWith: (code: number) => void = exitNow;
let handlers: (readonly [NodeJS.Signals, () => void])[] = [];

const runAll = (code: number): void => {
    for (const cleanup of cleanups) {
        try {
            cleanup();
        } catch {
            // One failing cleanup must not keep the others from running.
        }
    }

    cleanups.clear();
    exitWith(code);
};

/**
 * Run `cleanup` if the process is interrupted (Ctrl-C, a CI cancellation) while it is armed, then exit. A `finally`
 * does not run when the process is killed, so whatever a command must put back (a rewritten config, a temporary
 * file holding secrets, a lock) is also registered here. Returns the disarm to call once the command has cleaned up
 * normally. `exit` is for tests.
 */
const guardCleanup = (cleanup: () => void, exit?: (code: number) => void): (() => void) => {
    if (exit !== undefined) {
        exitWith = exit;
    }

    cleanups.add(cleanup);

    if (handlers.length === 0) {
        handlers = SIGNALS.map(([signal, code]) => {
            const handler = (): void => {
                runAll(code);
            };

            process.on(signal, handler);

            return [signal, handler] as const;
        });
    }

    return () => {
        cleanups.delete(cleanup);

        if (cleanups.size === 0) {
            for (const [signal, handler] of handlers) {
                process.off(signal, handler);
            }

            handlers = [];
            exitWith = exitNow;
        }
    };
};

export default guardCleanup;
