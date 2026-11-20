/**
 * The bundle scan's limits and budget: every cap it holds itself to, the
 * tenant-safe error it fails with, and the time and heap checks that enforce
 * the caps during the parse and the walks.
 */
import { getHeapStatistics } from "node:v8";

const MIB = 1024 * 1024;

/** Every cap the scan holds itself to. Injectable so tests can hit each one without a giant fixture. */
const DEFAULT_SCAN_LIMITS = Object.freeze({
    /**
     * Heap the scan is estimated to need per byte of bundle, for the up-front
     * check: a real 4 MiB wrangler bundle peaked at about 140 MiB without its
     * map (~35 bytes per byte), rounded up. An estimate only — dense code costs
     * more (`var a = 1;` lines measured ~80) — so the parse and walks also
     * watch the free heap and stop at `heapReserveBytes`.
     */
    heapBytesPerBundleByte: 48,
    /**
     * Heap a sourcemap needs per byte of file: its text, the parsed object and
     * the decode. Measured at about 1.3 (a 41.9 MiB synthetic map, and a real
     * 7.5 MiB wrangler map), rounded up for margin. A map that would not fit is
     * not read, and the scan goes on with bundle-line attribution.
     */
    heapBytesPerMapByte: 4,
    /**
     * Free heap the scan never eats into: below it, the parse or walk stops and
     * the scan is skipped. V8's `heap_size_limit` includes the young generation
     * (192 MiB above `--max-old-space-size` measured on Node 24), so "limit
     * minus used" overstates what the old space has left; the reserve covers
     * that share plus a margin for the allocations between two checks.
     */
    heapReserveBytes: 256 * MIB,
    /** Findings attributed only to the bundle (no sourcemap, no region comment) — likelier to be noise, so fewer. */
    maxBundleFindings: 10,
    /** The parse is synchronous and cannot be interrupted, so its input is bounded instead. */
    maxBundleBytes: 32 * MIB,
    maxFindings: 50,
    maxMapBytes: 64 * MIB,
    timeoutMs: 10_000,
});

/** @typedef {typeof DEFAULT_SCAN_LIMITS} ScanLimits */

/**
 * A failure whose message is safe to show the tenant — it names the cause,
 * never a path inside the box. Also what a walk throws once the deadline passes.
 */
class ScanError extends Error {}

/**
 * A budget check for the parse and the walks: throws once `deadline` has
 * passed, or once the heap has less than `reserve` bytes left. The clock is
 * read every 1024 calls and the heap every 16384 — cheap, and still far finer
 * than either budget. The heap is watched DURING the scan, not only estimated
 * before it, because how much heap a bundle costs depends on how dense its
 * code is, and running this process out of heap ends the build's stream with
 * no release — which fails the build.
 * @param {{ deadline: number, heapAvailable?: () => number, message: string, now: () => number, reserve?: number }} budget The clock and deadline, and optionally the free-heap reading and the floor under it.
 * @returns {() => void} The check; also throws immediately when already late.
 */
const budgetCheck = ({ deadline, heapAvailable: free, message, now, reserve = 0 }) => {
    let calls = 0;

    if (now() > deadline) {
        throw new ScanError(message);
    }

    return () => {
        calls += 1;

        if (calls % 1024 === 0 && now() > deadline) {
            throw new ScanError(message);
        }

        if (free !== undefined && calls % 16_384 === 0 && free() < reserve) {
            throw new ScanError("the scan ran low on memory and stopped before it could exhaust it");
        }
    };
};

/**
 * @returns {number} Bytes the heap can still grow by before this process runs out.
 */
const heapAvailable = () => {
    const { heap_size_limit: limit, used_heap_size: used } = getHeapStatistics();

    return limit - used;
};

/**
 * The up-front memory check: throws when the bundle's estimated share plus the
 * reserve exceeds the free heap, else answers what is left for the sourcemap.
 * @param {number} bundleBytes The bundle's size.
 * @param {typeof DEFAULT_SCAN_LIMITS} limits The caps.
 * @param {number} available Free heap, in bytes.
 * @returns {number} Heap bytes left for the sourcemap.
 */
const heapLeftForMap = (bundleBytes, limits, available) => {
    const needed = bundleBytes * limits.heapBytesPerBundleByte;

    if (needed + limits.heapReserveBytes > available) {
        throw new ScanError(
            `scanning a ${(bundleBytes / MIB).toFixed(1)} MiB bundle needs about ${String(Math.ceil(needed / MIB))} MiB of memory on top of a ${String(limits.heapReserveBytes / MIB)} MiB reserve, and ${String(Math.floor(available / MIB))} MiB is free`,
        );
    }

    return available - needed - limits.heapReserveBytes;
};

export { budgetCheck, DEFAULT_SCAN_LIMITS, heapAvailable, heapLeftForMap, MIB, ScanError };
