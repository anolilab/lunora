const SIGNALS = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
] as const;

/** How long an interrupted process waits for asynchronous cleanup (a lock release) before it exits anyway. */
const GRACE_MS = 5000;

const cleanups = new Set<() => Promise<void> | void>();
// eslint-disable-next-line unicorn/no-process-exit -- an interrupted CLI exits once its cleanup is done
const exitNow = (code: number): void => process.exit(code);
let exitWith: (code: number) => void = exitNow;
let handlers: (readonly [NodeJS.Signals, () => void])[] = [];

let shutdown: Promise<void> | undefined;

const cleanUpThenExit = async (code: number): Promise<void> => {
    // Each cleanup starts now, synchronously, so the work that needs no waiting is done before anything else can run.
    const started = [...cleanups].map(async (cleanup) => {
        try {
            await cleanup();
        } catch {
            // One failing cleanup must not keep the others from running.
        }
    });

    cleanups.clear();

    const grace = new Promise<void>((resolve) => {
        setTimeout(resolve, GRACE_MS).unref();
    });

    await Promise.race([Promise.all(started), grace]);
    exitWith(code);
};

// A repeated signal waits for the shutdown already running instead of exiting before its cleanup has finished.
const runAll = (code: number): Promise<void> => {
    shutdown ??= cleanUpThenExit(code);

    return shutdown;
};

/**
 * Run `cleanup` (it may be asynchronous, and is waited for briefly) if the process is interrupted (Ctrl-C, a CI cancellation) while it is armed, then exit. A `finally`
 * does not run when the process is killed, so whatever a command must put back (a rewritten config, a temporary
 * file holding secrets, a lock) is also registered here. Returns the disarm to call once the command has cleaned up
 * normally. `exit` is for tests.
 */
const guardCleanup = (cleanup: () => Promise<void> | void, exit?: (code: number) => void): (() => void) => {
    if (exit !== undefined) {
        exitWith = exit;
    }

    cleanups.add(cleanup);

    if (handlers.length === 0) {
        handlers = SIGNALS.map(([signal, code]) => {
            const handler = (): void => {
                runAll(code).catch(() => undefined);
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
            shutdown = undefined;
        }
    };
};

export default guardCleanup;
