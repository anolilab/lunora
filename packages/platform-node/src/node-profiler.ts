/**
 * On-demand profiler for the Node target.
 *
 * Captures a CPU or heap profile of the running process through the built-in
 * inspector, with no native addon and no flag set at boot. The result is a
 * gzip-compressed pprof. A CPU capture samples whatever the process is running
 * during the window, so the process must be doing work for the profile to show
 * anything. A heap capture reports the sampled allocations still alive when it
 * stops (see `heapProfileToPprof`).
 *
 * The inspector's callback API is wrapped rather than `node:inspector/promises`,
 * which the supported Node range still lists as experimental.
 *
 * One capture runs at a time per process. The lock is module-scoped because
 * every `createNodeProfiler()` instance drives the same isolate's profiler, and
 * two sessions profiling at once would corrupt each other's samples.
 */
import { Session } from "node:inspector";

import { LunoraError } from "@lunora/errors";

import type { V8CpuProfile, V8SamplingHeapProfile } from "./node-profile-pprof";
import { cpuProfileToPprof, encodePprofGzip, heapProfileToPprof } from "./node-profile-pprof";

type NodeProfileType = "cpu" | "heap";

interface NodeProfileRequest {
    /** Capture window in milliseconds, an integer from 1000 to 50000. */
    durationMs: number;
    profileType: NodeProfileType;
}

interface NodeProfiler {
    /** Capture for `durationMs` and resolve with the gzip-compressed pprof. Rejects with `BAD_REQUEST` on bad input and `CONFLICT` while another capture runs. */
    capture: (request: NodeProfileRequest) => Promise<Uint8Array>;
}

const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 50_000;
const PROFILE_TYPES: ReadonlyArray<NodeProfileType> = ["cpu", "heap"];

/** CPU sampling interval, 1 ms (V8's default). Set explicitly so the pprof `period` always matches the sampling. */
const CPU_SAMPLING_INTERVAL_MICROS = 1000;

/** V8's default heap sampling interval, 32 KiB. */
const HEAP_SAMPLING_INTERVAL_BYTES = 32_768;

/** Module-scoped: see the file comment. */
let captureInProgress = false;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/** `session.post` as a promise. The inspector reports failures through the callback's first argument. */
const post = <T>(session: Session, method: string, params?: object): Promise<T> =>
    new Promise((resolve, reject) => {
        session.post(method, params, (error, result) => {
            if (error === null) {
                resolve(result as T);
            } else {
                reject(error);
            }
        });
    });

/** Throws `BAD_REQUEST` unless `request` names a profile type and a window the capture accepts. */
const assertValidRequest = (request: NodeProfileRequest): void => {
    if (!PROFILE_TYPES.includes(request.profileType)) {
        throw new LunoraError("BAD_REQUEST", `profile type must be one of ${PROFILE_TYPES.join(", ")}`);
    }

    if (!Number.isInteger(request.durationMs) || request.durationMs < MIN_DURATION_MS || request.durationMs > MAX_DURATION_MS) {
        throw new LunoraError("BAD_REQUEST", `duration must be an integer from ${String(MIN_DURATION_MS)} to ${String(MAX_DURATION_MS)} ms`);
    }
};

/** Runs one capture on a fresh inspector session and always disconnects it. */
const runCapture = async (request: NodeProfileRequest): Promise<Uint8Array> => {
    const session = new Session();
    const startedAtMs = Date.now();
    // Set once the profiler is running, so the cleanup knows whether to stop it.
    let running: NodeProfileType | undefined;

    session.connect();

    try {
        if (request.profileType === "cpu") {
            await post(session, "Profiler.enable");
            await post(session, "Profiler.setSamplingInterval", { interval: CPU_SAMPLING_INTERVAL_MICROS });
            await post(session, "Profiler.start");
            running = "cpu";

            await sleep(request.durationMs);

            const { profile } = await post<{ profile: V8CpuProfile }>(session, "Profiler.stop");

            running = undefined;

            return encodePprofGzip(cpuProfileToPprof(profile, { intervalMicros: CPU_SAMPLING_INTERVAL_MICROS, startedAtMs }));
        }

        await post(session, "HeapProfiler.startSampling", { samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES });
        running = "heap";

        await sleep(request.durationMs);

        const { profile } = await post<{ profile: V8SamplingHeapProfile }>(session, "HeapProfiler.stopSampling");

        running = undefined;

        return encodePprofGzip(
            heapProfileToPprof(profile, {
                durationMs: request.durationMs,
                samplingIntervalBytes: HEAP_SAMPLING_INTERVAL_BYTES,
                startedAtMs,
            }),
        );
    } finally {
        if (running === "cpu") {
            await post(session, "Profiler.stop").catch(() => undefined);
        } else if (running === "heap") {
            await post(session, "HeapProfiler.stopSampling").catch(() => undefined);
        }

        session.disconnect();
    }
};

/**
 * Build a profiler for this process. The instance holds no state of its own:
 * the one-capture-at-a-time guarantee lives at module scope, so instances are
 * interchangeable.
 */
const createNodeProfiler = (): NodeProfiler => {
    return {
        capture: async (request) => {
            assertValidRequest(request);

            if (captureInProgress) {
                throw new LunoraError("CONFLICT", "a profile capture is already running in this process", {
                    hint: "Wait for the running capture to finish, then retry.",
                });
            }

            captureInProgress = true;

            try {
                return await runCapture(request);
            } finally {
                captureInProgress = false;
            }
        },
    };
};

export type { NodeProfiler, NodeProfileRequest, NodeProfileType };
export { createNodeProfiler };
