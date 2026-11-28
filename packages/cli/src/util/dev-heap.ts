/**
 * The V8 heap a detached `lunora dev` gets.
 *
 * A dev session with several in-session services has run out of V8's default
 * old-space limit (about 4 GB on a 64-bit build) while starting, with tens of GB of
 * system memory free, and a raised `--max-old-space-size` let the same start
 * finish. The background launcher hands the detached server its environment, so it
 * sets the flag there through `NODE_OPTIONS`, which every Node descendant (wrangler,
 * Vite, esbuild's host) inherits too. A foreground run cannot raise its own heap
 * after it has started; `NODE_OPTIONS` stays the way to do that.
 */
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";

/** The old-space size a background dev server is given when memory allows, in MiB. */
const DEV_HEAP_TARGET_MB = 8192;

const MIB = 1024 * 1024;

/** Matches either spelling V8 accepts, so a limit the user chose is never overridden. */
const HEAP_FLAG = /--max[-_]old[-_]space[-_]size/u;

/** How much memory this process may use and the heap limit V8 runs with, in bytes. */
interface HeapMemory {
    availableBytes: number;
    currentLimitBytes: number;
}

const measureMemory = (): HeapMemory => {
    // 0 (or, on some releases, a huge sentinel) when no cgroup limit applies, which the `min` with total memory absorbs.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- present (experimental) on every supported Node; only its stability label differs
    const constrained = process.constrainedMemory();

    return {
        availableBytes: Math.min(constrained > 0 ? constrained : Number.POSITIVE_INFINITY, totalmem()),
        currentLimitBytes: getHeapStatistics().heap_size_limit,
    };
};

/**
 * The `NODE_OPTIONS` value for the detached server, or `undefined` to leave the
 * variable as it is: the user already set a heap size, or raising it would not
 * help.
 *
 * Capped at three quarters of the memory this process may use (a cgroup limit
 * when there is one), so a small container is never promised more heap than it
 * has, and never set below the limit V8 already runs with.
 */
const devHeapNodeOptions = (existing: string | undefined, memory: HeapMemory = measureMemory()): string | undefined => {
    if (existing !== undefined && HEAP_FLAG.test(existing)) {
        return undefined;
    }

    const sizeMb = Math.min(DEV_HEAP_TARGET_MB, Math.floor((memory.availableBytes * 0.75) / MIB));

    if (sizeMb * MIB <= memory.currentLimitBytes) {
        return undefined;
    }

    const flag = `--max-old-space-size=${String(sizeMb)}`;

    return existing === undefined || existing.trim() === "" ? flag : `${existing} ${flag}`;
};

/** Matches V8's fatal out-of-memory line. */
const HEAP_EXHAUSTED = /JavaScript heap out of memory|Ineffective mark-compacts near heap limit/u;

// eslint-disable-next-line no-secrets/no-secrets -- a flag name with a placeholder, not a credential
const HEAP_ADVICE = "It ran out of V8 heap. Raise the limit with NODE_OPTIONS=--max-old-space-size=<MiB> and start it again.";

/** How to raise the limit, when a dead server's log shows V8 ran out of heap. */
const heapExhaustedAdvice = (logTail: ReadonlyArray<string>): string | undefined =>
    logTail.some((line) => HEAP_EXHAUSTED.test(line)) ? HEAP_ADVICE : undefined;

/** `environment` with the heap flag from {@link devHeapNodeOptions} added to its `NODE_OPTIONS`. */
const withDevHeap = (environment: Record<string, string | undefined>): Record<string, string | undefined> => {
    const nodeOptions = devHeapNodeOptions(environment["NODE_OPTIONS"]);

    return nodeOptions === undefined ? environment : { ...environment, NODE_OPTIONS: nodeOptions };
};

export { DEV_HEAP_TARGET_MB, devHeapNodeOptions, heapExhaustedAdvice, withDevHeap };
