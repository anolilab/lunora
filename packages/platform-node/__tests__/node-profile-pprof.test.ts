import { gunzipSync } from "node:zlib";

import { Profile } from "pprof-format";
import { describe, expect, it } from "vitest";

import type { V8CpuProfile, V8SamplingHeapProfile } from "../src/node-profile-pprof";
import { cpuProfileToPprof, encodePprofGzip, heapProfileToPprof } from "../src/node-profile-pprof";

/** pprof decodes numeric fields as `number | bigint`; this is the one place that normalises them for assertions. */
const num = Number;

/** Reads a gzip pprof back the way `go tool pprof` would: gunzip, then protobuf-decode. */
const decodeGzip = (bytes: Uint8Array): Profile => Profile.decode(gunzipSync(bytes));

const str = (profile: Profile, index: number | bigint): string => profile.stringTable.strings[num(index)] ?? "";

/** Leaf-first function names of one sample's stack. */
const stackOf = (profile: Profile, locationIds: ReadonlyArray<number | bigint>): string[] =>
    locationIds.map((locationId) => {
        const location = profile.location.find((candidate) => num(candidate.id) === num(locationId));
        const functionId = location?.line[0]?.functionId ?? 0;
        const fn = profile.function.find((candidate) => num(candidate.id) === num(functionId));

        return fn === undefined ? "?" : str(profile, fn.name);
    });

const sampleTypes = (profile: Profile): string[] => profile.sampleType.map((type) => `${str(profile, type.type)}/${str(profile, type.unit)}`);

// A hand-built V8 CPU profile with a known answer:
//   (root)
//   ├─ main (app/main.js:10:5)          -> sampled once
//   │  └─ busyWork (app/work.js:3:1)    -> sampled three times
//   └─ (program)                        -> sampled once
// Each sample stands for 1000 microseconds (timeDeltas), so 1 ms of CPU each.
//
const cpuFixture = (): V8CpuProfile => {
    return {
        endTime: 1_005_000,
        nodes: [
            { callFrame: { columnNumber: -1, functionName: "(root)", lineNumber: -1, url: "" }, children: [2, 3], id: 1 },
            { callFrame: { columnNumber: 4, functionName: "main", lineNumber: 9, url: "file:///app/main.js" }, children: [4], id: 2 },
            { callFrame: { columnNumber: -1, functionName: "(program)", lineNumber: -1, url: "" }, children: [], id: 3 },
            { callFrame: { columnNumber: 0, functionName: "busyWork", lineNumber: 2, url: "file:///app/work.js" }, children: [], id: 4 },
        ],
        samples: [4, 4, 4, 2, 3],
        startTime: 1_000_000,
        timeDeltas: [1000, 1000, 1000, 1000, 1000],
    };
};

describe("cpuProfileToPprof", () => {
    it("declares samples/count and cpu/nanoseconds, with the cpu period", () => {
        expect.assertions(3);

        const profile = decodeGzip(encodePprofGzip(cpuProfileToPprof(cpuFixture(), { intervalMicros: 1000, startedAtMs: 1_700_000_000_000 })));

        expect(sampleTypes(profile)).toStrictEqual(["samples/count", "cpu/nanoseconds"]);
        expect(num(profile.period)).toBe(1_000_000);
        expect(str(profile, profile.periodType?.type ?? 0)).toBe("cpu");
    });

    it("merges samples that share a stack and sums their values", () => {
        expect.assertions(3);

        const profile = cpuProfileToPprof(cpuFixture(), { intervalMicros: 1000, startedAtMs: 0 });
        const byStack = new Map(profile.sample.map((sample) => [stackOf(profile, sample.locationId).join(" < "), sample.value.map((value) => num(value))]));

        expect(profile.sample).toHaveLength(3);
        expect(byStack.get("busyWork < main")).toStrictEqual([3, 3_000_000]);
        expect(byStack.get("main")).toStrictEqual([1, 1_000_000]);
    });

    it("drops the synthetic (root) frame and keeps (program)", () => {
        expect.assertions(2);

        const profile = cpuProfileToPprof(cpuFixture(), { intervalMicros: 1000, startedAtMs: 0 });
        const names = profile.function.map((fn) => str(profile, fn.name));

        expect(names).not.toContain("(root)");
        expect(names).toContain("(program)");
    });

    it("lays out 1-based ids and 1-based lines, with the function name and file", () => {
        expect.assertions(6);

        const profile = cpuProfileToPprof(cpuFixture(), { intervalMicros: 1000, startedAtMs: 0 });
        const busy = profile.function.find((fn) => str(profile, fn.name) === "busyWork");
        const busyLocation = profile.location.find((location) => num(location.line[0]?.functionId ?? 0) === num(busy?.id ?? 0));

        expect(busy).toBeDefined();
        expect(num(busy?.id ?? 0)).toBeGreaterThan(0);
        expect(str(profile, busy?.filename ?? 0)).toBe("file:///app/work.js");
        expect(num(busy?.startLine ?? 0)).toBe(3);
        expect(num(busyLocation?.line[0]?.line ?? 0)).toBe(3);
        expect(num(busyLocation?.line[0]?.column ?? 0)).toBe(1);
    });

    it("names an anonymous function (anonymous) and keeps the string table's empty first entry", () => {
        expect.assertions(2);

        const fixture = cpuFixture();

        fixture.nodes[3] = { callFrame: { columnNumber: 0, functionName: "", lineNumber: 0, url: "file:///app/work.js" }, children: [], id: 4 };

        const profile = cpuProfileToPprof(fixture, { intervalMicros: 1000, startedAtMs: 0 });

        expect(profile.function.map((fn) => str(profile, fn.name))).toContain("(anonymous)");
        expect(profile.stringTable.strings[0]).toBe("");
    });

    it("uses the wall-clock start and the V8 window length", () => {
        expect.assertions(2);

        const profile = cpuProfileToPprof(cpuFixture(), { intervalMicros: 1000, startedAtMs: 1_700_000_000_000 });

        expect(num(profile.timeNanos)).toBe(1_700_000_000_000_000_000);
        expect(num(profile.durationNanos)).toBe(5_000_000);
    });

    it("encodes to gzip that decodes back to the same profile", () => {
        expect.assertions(2);

        const gzipped = encodePprofGzip(cpuProfileToPprof(cpuFixture(), { intervalMicros: 1000, startedAtMs: 0 }));

        expect(gzipped[0]).toBe(0x1f);
        expect(decodeGzip(gzipped).sample).toHaveLength(3);
    });
});

// A hand-built sampling heap profile:
//   (root)
//   └─ allocate (app/alloc.js:5:3)
//      └─ build (app/alloc.js:12:1)
// Two live allocations of 64 and 32 bytes from `build`, one of 100 from `allocate`.
//
const heapFixture = (): V8SamplingHeapProfile => {
    return {
        head: {
            callFrame: { columnNumber: -1, functionName: "(root)", lineNumber: -1, url: "" },
            children: [
                {
                    callFrame: { columnNumber: 2, functionName: "allocate", lineNumber: 4, url: "file:///app/alloc.js" },
                    children: [{ callFrame: { columnNumber: 0, functionName: "build", lineNumber: 11, url: "file:///app/alloc.js" }, children: [], id: 3 }],
                    id: 2,
                },
            ],
            id: 1,
        },
        samples: [
            { nodeId: 3, size: 64 },
            { nodeId: 3, size: 32 },
            { nodeId: 2, size: 100 },
        ],
    };
};

describe("heapProfileToPprof", () => {
    it("declares objects/count and space/bytes, with the sampling interval as the period", () => {
        expect.assertions(3);

        const profile = heapProfileToPprof(heapFixture(), { durationMs: 2000, samplingIntervalBytes: 32_768, startedAtMs: 0 });

        expect(sampleTypes(profile)).toStrictEqual(["objects/count", "space/bytes"]);
        expect(num(profile.period)).toBe(32_768);
        expect(num(profile.durationNanos)).toBe(2_000_000_000);
    });

    it("sums allocations per stack and walks the nested tree leaf-first", () => {
        expect.assertions(3);

        const profile = heapProfileToPprof(heapFixture(), { durationMs: 2000, samplingIntervalBytes: 32_768, startedAtMs: 0 });
        const byStack = new Map(profile.sample.map((sample) => [stackOf(profile, sample.locationId).join(" < "), sample.value.map((value) => num(value))]));

        expect(profile.sample).toHaveLength(2);
        expect(byStack.get("build < allocate")).toStrictEqual([2, 96]);
        expect(byStack.get("allocate")).toStrictEqual([1, 100]);
    });
});
