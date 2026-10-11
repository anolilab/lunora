/**
 * V8 profile -> pprof converter for the on-demand Node profiler.
 *
 * V8 reports two shapes: a CPU `cpuprofile` (a call tree, one node id per
 * sample, and the microseconds before each sample) and a sampling heap profile
 * (a call tree plus one `(node, size)` record per sampled allocation). Both
 * reduce to what pprof stores: frames keyed by node id, and samples that point
 * at a node and carry values. `buildPprof` does that reduction once; the two
 * `*ToPprof` functions translate their V8 shape into its input.
 *
 * Conventions a pprof reader relies on, all kept here: every id is 1-based and
 * nonzero; string index 0 is `""`; a sample's `locationId` list is leaf-first;
 * V8's 0-based line and column become 1-based pprof values (0 means unknown);
 * the synthetic root frame is dropped; an anonymous function is named
 * `(anonymous)`. Locations carry no mapping (`mappingId` 0), which the pprof
 * format allows when the binary is not known.
 */
import { gzipSync } from "node:zlib";

import type { FunctionInput, LocationInput, SampleInput } from "pprof-format";
import { Profile, StringTable } from "pprof-format";

/** One frame as V8 reports it. */
interface V8CallFrame {
    columnNumber: number;
    functionName: string;
    lineNumber: number;
    url: string;
}

/** A node of a V8 CPU profile. `children` are node ids, not nodes. */
interface V8CpuProfileNode {
    callFrame: V8CallFrame;
    children?: number[];
    id: number;
}

/** The `Profiler.stop` payload. Times are microseconds; `samples` are node ids; `timeDeltas[i]` is the gap before sample `i`. */
interface V8CpuProfile {
    endTime: number;
    nodes: V8CpuProfileNode[];
    samples: number[];
    startTime: number;
    timeDeltas: number[];
}

/** A node of a V8 sampling heap profile. `children` are nested nodes. */
interface V8HeapProfileNode {
    callFrame: V8CallFrame;
    children: V8HeapProfileNode[];
    id: number;
}

/** One sampled allocation: its size in bytes and the heap-tree node it was made from. */
interface V8HeapProfileSample {
    nodeId: number;
    size: number;
}

/** The `HeapProfiler.stopSampling` payload. */
interface V8SamplingHeapProfile {
    head: V8HeapProfileNode;
    samples: V8HeapProfileSample[];
}

/** A sample type, as pprof names it: `type/unit`. */
interface SampleTypeSpec {
    type: string;
    unit: string;
}

/** A frame in the reduced tree: its call site, and the node it was called from (`undefined` for the root). */
interface FrameNode {
    callFrame: V8CallFrame;
    parentId: number | undefined;
}

/** One captured sample: the node it was taken at and one value per sample type. */
interface ReducedSample {
    nodeId: number;
    values: number[];
}

interface BuildOptions {
    /** Capture length, in nanoseconds. */
    durationNanos: number;
    /** Frames keyed by node id. */
    frames: ReadonlyMap<number, FrameNode>;
    /** The sampling period, in the unit of `periodType`. */
    period: number;
    periodType: SampleTypeSpec;
    samples: ReadonlyArray<ReducedSample>;
    /** Sample types, in the order each sample's `values` is laid out. The last one is pprof's default view. */
    sampleTypes: SampleTypeSpec[];
    /** Capture start, in nanoseconds since the epoch. */
    startNanos: number;
}

const ANONYMOUS_FUNCTION = "(anonymous)";

/** V8 uses `-1` for an unknown line or column; pprof uses `0`. Otherwise V8 is 0-based and pprof is 1-based. */
const toPprofPosition = (zeroBased: number): number => (zeroBased >= 0 ? zeroBased + 1 : 0);

/**
 * Reduce frames and samples to a pprof `Profile`. Samples that resolve to the
 * same stack are summed, so the output carries one pprof sample per distinct
 * stack rather than one per V8 sample.
 */
const buildPprof = (options: BuildOptions): Profile => {
    const stringTable = new StringTable();
    const functions: FunctionInput[] = [];
    const locations: LocationInput[] = [];
    const functionIds = new Map<string, number>();
    const locationIds = new Map<string, number>();

    // V8 gives each function its definition position, so two functions with one name in one file are
    // told apart by where they start, not merged.
    const functionIdFor = (name: string, frame: V8CallFrame): number => {
        const key = `${name}\u0000${frame.url}\u0000${String(frame.lineNumber)}\u0000${String(frame.columnNumber)}`;
        const existing = functionIds.get(key);

        if (existing !== undefined) {
            return existing;
        }

        const id = functions.length + 1;

        functionIds.set(key, id);
        functions.push({
            filename: stringTable.dedup(frame.url),
            id,
            name: stringTable.dedup(name),
            startLine: toPprofPosition(frame.lineNumber),
            systemName: stringTable.dedup(name),
        });

        return id;
    };

    const locationFor = (frame: V8CallFrame): number => {
        const name = frame.functionName === "" ? ANONYMOUS_FUNCTION : frame.functionName;
        const functionId = functionIdFor(name, frame);
        const line = toPprofPosition(frame.lineNumber);
        const column = toPprofPosition(frame.columnNumber);
        const key = `${String(functionId)}\u0000${String(line)}\u0000${String(column)}`;
        const existing = locationIds.get(key);

        if (existing !== undefined) {
            return existing;
        }

        const id = locations.length + 1;

        locationIds.set(key, id);
        locations.push({ id, line: [{ column, functionId, line }] });

        return id;
    };

    const stackCache = new Map<number, number[]>();

    /** Location ids for a node, leaf first. The root (the frame with no parent) is left out. */
    const stackOf = (nodeId: number): number[] => {
        const cached = stackCache.get(nodeId);

        if (cached !== undefined) {
            return cached;
        }

        const stack: number[] = [];
        let current = options.frames.get(nodeId);

        while (current?.parentId !== undefined) {
            stack.push(locationFor(current.callFrame));
            current = options.frames.get(current.parentId);
        }

        stackCache.set(nodeId, stack);

        return stack;
    };

    const aggregated = new Map<string, { locationId: number[]; values: number[] }>();

    for (const sample of options.samples) {
        const locationId = stackOf(sample.nodeId);
        const key = locationId.join(",");
        const existing = aggregated.get(key);

        if (existing === undefined) {
            aggregated.set(key, { locationId, values: [...sample.values] });
        } else {
            existing.values = existing.values.map((value, index) => value + (sample.values[index] ?? 0));
        }
    }

    const samples: SampleInput[] = [...aggregated.values()].map((entry) => {
        return { locationId: entry.locationId, value: entry.values };
    });

    return new Profile({
        durationNanos: options.durationNanos,
        function: functions,
        location: locations,
        period: options.period,
        periodType: { type: stringTable.dedup(options.periodType.type), unit: stringTable.dedup(options.periodType.unit) },
        sample: samples,
        sampleType: options.sampleTypes.map((sampleType) => {
            return { type: stringTable.dedup(sampleType.type), unit: stringTable.dedup(sampleType.unit) };
        }),
        stringTable,
        timeNanos: options.startNanos,
    });
};

/** Frames of a CPU profile. A node's parent is the node whose `children` list names it. */
const cpuFrames = (profile: V8CpuProfile): Map<number, FrameNode> => {
    const parentOf = new Map<number, number>();

    for (const node of profile.nodes) {
        for (const child of node.children ?? []) {
            parentOf.set(child, node.id);
        }
    }

    return new Map(profile.nodes.map((node) => [node.id, { callFrame: node.callFrame, parentId: parentOf.get(node.id) }]));
};

/** Frames of a heap profile, flattened out of the nested tree. Iterative, so a deep stack cannot overflow the call stack. */
const heapFrames = (head: V8HeapProfileNode): Map<number, FrameNode> => {
    const frames = new Map<number, FrameNode>();
    const pending: { node: V8HeapProfileNode; parentId: number | undefined }[] = [{ node: head, parentId: undefined }];

    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        frames.set(next.node.id, { callFrame: next.node.callFrame, parentId: next.parentId });

        for (const child of next.node.children) {
            pending.push({ node: child, parentId: next.node.id });
        }
    }

    return frames;
};

const CPU_SAMPLE_TYPES: SampleTypeSpec[] = [
    { type: "samples", unit: "count" },
    { type: "cpu", unit: "nanoseconds" },
];

/**
 * Heap has one sample type. V8 reports each sampled allocation with its size and does not
 * scale it up, so a per-sample count would always be 1 and carry no information.
 */
const HEAP_SAMPLE_TYPES: SampleTypeSpec[] = [{ type: "space", unit: "bytes" }];

/** Milliseconds to nanoseconds, the unit pprof's `time_nanos` and `duration_nanos` use. */
const millisToNanos = (millis: number): number => millis * 1_000_000;

/**
 * Convert a CPU profile from `Profiler.stop`. `startedAtMs` is the wall-clock
 * time the capture began: V8's `startTime` is on its monotonic clock, not a
 * date. `intervalMicros` is the sampling interval that was set before start.
 */
const cpuProfileToPprof = (profile: V8CpuProfile, options: { intervalMicros: number; startedAtMs: number }): Profile =>
    buildPprof({
        durationNanos: (profile.endTime - profile.startTime) * 1000,
        frames: cpuFrames(profile),
        period: options.intervalMicros * 1000,
        periodType: { type: "cpu", unit: "nanoseconds" },
        // `timeDeltas[i]` is the time since sample i-1, so it is the time sample i stands for.
        samples: profile.samples.map((nodeId, index) => {
            return { nodeId, values: [1, (profile.timeDeltas[index] ?? 0) * 1000] };
        }),
        sampleTypes: CPU_SAMPLE_TYPES,
        startNanos: millisToNanos(options.startedAtMs),
    });

/**
 * Convert a sampling heap profile from `HeapProfiler.stopSampling`. V8 keeps
 * only the sampled allocations still alive when sampling stops, so the values
 * describe live memory at that moment, not every allocation in the window.
 */
const heapProfileToPprof = (profile: V8SamplingHeapProfile, options: { durationMs: number; samplingIntervalBytes: number; startedAtMs: number }): Profile =>
    buildPprof({
        durationNanos: millisToNanos(options.durationMs),
        frames: heapFrames(profile.head),
        period: options.samplingIntervalBytes,
        periodType: { type: "space", unit: "bytes" },
        samples: profile.samples.map((sample) => {
            return { nodeId: sample.nodeId, values: [sample.size] };
        }),
        sampleTypes: HEAP_SAMPLE_TYPES,
        startNanos: millisToNanos(options.startedAtMs),
    });

/** The gzip-compressed protobuf that `go tool pprof`, Pyroscope and Speedscope read. */
const encodePprofGzip = (profile: Profile): Uint8Array => new Uint8Array(gzipSync(profile.encode()));

export type { V8CpuProfile, V8SamplingHeapProfile };
export { cpuProfileToPprof, encodePprofGzip, heapProfileToPprof };
