import { describe, expect, it } from "vitest";

import { otlpRandomHex } from "../../../shared/otlp";
import { detectCloudflareResource, detectHostResource, detectServiceResource, mergeResourceAttributes, readerFromRecord } from "../../../shared/otlp-resource";
import { createResourceAttributeResolver } from "../src/resource-detect";

describe("shared/otlp-resource", () => {
    describe("readerFromRecord", () => {
        it("reads string values and treats everything else as absent", () => {
            expect.assertions(4);

            // A Worker's `env` holds KV namespaces, secrets stores and other
            // non-string bindings alongside plain vars; only real strings are vars.
            const read = readerFromRecord({ BINDING: { get: () => undefined }, EMPTY: "", NUMERIC: 3, VERSION: "v1" });

            expect(read("VERSION")).toBe("v1");
            expect(read("BINDING")).toBeUndefined();
            expect(read("NUMERIC")).toBeUndefined();
            expect(read("EMPTY")).toBeUndefined();
        });

        it("unwraps a Cloudflare version_metadata binding, preferring its tag", () => {
            expect.assertions(3);

            // The binding is an OBJECT, so a strict string reader made
            // `CF_VERSION_METADATA` unreadable — `service.version` auto-detection
            // could never fire on the platform it was written for.
            const tagged = readerFromRecord({ CF_VERSION_METADATA: { id: "8ee9-4b4d", tag: "v1.4.0", timestamp: "2026-01-01T00:00:00Z" } });

            expect(tagged("CF_VERSION_METADATA")).toBe("v1.4.0");

            // A deployment that set no tag still has a version id.
            const untagged = readerFromRecord({ CF_VERSION_METADATA: { id: "8ee9-4b4d", tag: "", timestamp: "2026-01-01T00:00:00Z" } });

            expect(untagged("CF_VERSION_METADATA")).toBe("8ee9-4b4d");

            expect(detectServiceResource(tagged)["service.version"]).toBe("v1.4.0");
        });

        it("tolerates an absent environment", () => {
            expect.assertions(1);

            expect(readerFromRecord(undefined)("VERSION")).toBeUndefined();
        });
    });

    describe("detectServiceResource", () => {
        it("prefers an explicit SERVICE_VERSION over platform-injected shas", () => {
            expect.assertions(1);

            const attributes = detectServiceResource(readerFromRecord({ GITHUB_SHA: "sha", SERVICE_VERSION: "v1.2.3", VERCEL_GIT_COMMIT_SHA: "vercel" }));

            expect(attributes["service.version"]).toBe("v1.2.3");
        });

        it.each([["CF_VERSION_METADATA"], ["VERCEL_GIT_COMMIT_SHA"], ["GITHUB_SHA"], ["COMMIT_SHA"]])("falls back to %s", (key) => {
            expect.assertions(1);

            expect(detectServiceResource(readerFromRecord({ [key]: "abc123" }))["service.version"]).toBe("abc123");
        });

        it.each([["DEPLOYMENT_ENVIRONMENT"], ["ENVIRONMENT"], ["NODE_ENV"]])("reads deployment.environment from %s", (key) => {
            expect.assertions(1);

            expect(detectServiceResource(readerFromRecord({ [key]: "production" }))["deployment.environment"]).toBe("production");
        });

        it("omits attributes it cannot determine rather than guessing", () => {
            expect.assertions(1);

            expect(detectServiceResource(readerFromRecord({}))).toStrictEqual({});
        });
    });

    describe("detectHostResource", () => {
        it("reports host.name and the pid the caller supplies", () => {
            expect.assertions(2);

            const attributes = detectHostResource(readerFromRecord({ HOSTNAME: "box-1" }), 42);

            expect(attributes["host.name"]).toBe("box-1");
            expect(attributes["process.pid"]).toBe(42);
        });

        // HOSTNAME is the pod name only under Kubernetes; elsewhere it is just the
        // machine name, which is already reported as host.name.
        it("only reports k8s.pod.name when actually running under Kubernetes", () => {
            expect.assertions(2);

            expect(detectHostResource(readerFromRecord({ HOSTNAME: "box-1" }))["k8s.pod.name"]).toBeUndefined();
            expect(detectHostResource(readerFromRecord({ HOSTNAME: "pod-1", KUBERNETES_SERVICE_HOST: "kubernetes.default.svc" }))["k8s.pod.name"]).toBe(
                "pod-1",
            );
        });

        it("reports an explicitly named pod without the in-cluster service env", () => {
            expect.assertions(1);

            // The `KUBERNETES_SERVICE_HOST` gate exists for the HOSTNAME fallback —
            // a machine name is not a pod name. `KUBERNETES_POD_NAME` needs no such
            // corroboration: it says what it is. Gating it too dropped the
            // attribute wherever the pod name is injected without the in-cluster
            // service env alongside it.
            expect(detectHostResource(readerFromRecord({ HOSTNAME: "box-1", KUBERNETES_POD_NAME: "pod-7" }))["k8s.pod.name"]).toBe("pod-7");
        });

        it("omits process.pid when the host has none", () => {
            expect.assertions(1);

            expect(detectHostResource(readerFromRecord({}))["process.pid"]).toBeUndefined();
        });
    });

    describe("detectCloudflareResource", () => {
        it("returns nothing when there is no sign of Cloudflare", () => {
            expect.assertions(1);

            expect(detectCloudflareResource(readerFromRecord({}))).toStrictEqual({});
        });

        it("reads the colo off the request's cf bag", () => {
            expect.assertions(2);

            const attributes = detectCloudflareResource(readerFromRecord({}), { colo: "SFO" });

            expect(attributes["cloud.provider"]).toBe("cloudflare");
            expect(attributes["cloud.region"]).toBe("SFO");
        });

        it("falls back to env for request-less paths such as crons", () => {
            expect.assertions(1);

            expect(detectCloudflareResource(readerFromRecord({ CF_ACCOUNT_ID: "abc", CF_COLO: "LHR" }))["cloud.region"]).toBe("LHR");
        });

        it("ignores a cf bag whose colo is not a string", () => {
            expect.assertions(2);

            const attributes = detectCloudflareResource(readerFromRecord({}), { colo: 42 });

            expect(attributes["cloud.provider"]).toBe("cloudflare");
            expect(attributes["cloud.region"]).toBeUndefined();
        });
    });

    describe("mergeResourceAttributes", () => {
        it("lets later bags win, which is what puts explicit config above detection", () => {
            expect.assertions(2);

            const merged = mergeResourceAttributes({ "cloud.region": "detected", "service.version": "v1" }, { "cloud.region": "explicit" });

            expect(merged["cloud.region"]).toBe("explicit");
            expect(merged["service.version"]).toBe("v1");
        });

        it("skips absent bags and never aliases an input", () => {
            expect.assertions(2);

            const source = { "service.version": "v1" };
            const merged = mergeResourceAttributes(undefined, source, undefined);

            expect(merged).toStrictEqual(source);
            expect(merged).not.toBe(source);
        });
    });
});

describe("createResourceAttributeResolver", () => {
    it("composes only the detectors a Worker can satisfy", () => {
        expect.assertions(2);

        // `HOSTNAME` would be a container/Kubernetes signal; a Worker's `env` is a
        // bindings bag, so probing for it here would be a dead branch.
        const request = new Request("https://api.example.com/_lunora/rpc");
        Object.defineProperty(request, "cf", { value: { colo: "SFO" }, writable: false });

        const attributes = createResourceAttributeResolver({ HOSTNAME: "box-1", SERVICE_VERSION: "v1.2.3" }, request)();

        expect(attributes).toStrictEqual({ "cloud.provider": "cloudflare", "cloud.region": "SFO", "service.version": "v1.2.3" });
        expect(attributes["host.name"]).toBeUndefined();
    });

    // Detection is a per-request constant, and this runs behind every log line,
    // metric and span — so it must resolve at most once.
    it("memoizes so repeated reads cost nothing", () => {
        expect.assertions(1);

        const resolve = createResourceAttributeResolver({ SERVICE_VERSION: "v1" }, new Request("https://api.example.com/"));

        expect(resolve()).toBe(resolve());
    });

    it("works with no env and no request", () => {
        expect.assertions(1);

        expect(createResourceAttributeResolver(undefined)()).toStrictEqual({});
    });
});

/**
 * `otlpRandomHex` serves ids out of a buffer refilled from
 * `crypto.getRandomValues` rather than drawing per call — the draw was ~9% of
 * the worker's RPC dispatch path. The pool must stay invisible: same alphabet,
 * same length, same one-use-per-byte stream, and no reuse across a refill
 * boundary. It must also not corrupt an id larger than the pool itself.
 */
describe(otlpRandomHex, () => {
    it("returns lowercase hex of exactly the requested byte length", () => {
        expect.assertions(4);

        expect(otlpRandomHex(8)).toMatch(/^[0-9a-f]{16}$/u);
        expect(otlpRandomHex(16)).toMatch(/^[0-9a-f]{32}$/u);
        expect(otlpRandomHex(8)).toHaveLength(16);
        expect(otlpRandomHex(16)).toHaveLength(32);
    });

    it("never repeats an id across many refills of the pool", () => {
        expect.assertions(1);

        // The pool holds 512 bytes, so 4096 x 16-byte ids cross its refill
        // boundary ~128 times. A slot handed out twice — the one way a pooled
        // implementation can go wrong that a per-call draw cannot — shows up
        // here as a duplicate; a collision by chance is ~2^-128.
        const ids = new Set<string>();

        for (let index = 0; index < 4096; index += 1) {
            ids.add(otlpRandomHex(16));
        }

        expect(ids.size).toBe(4096);
    });

    it("stays hex for an id larger than the pool", () => {
        expect.assertions(2);

        // Past the pool size the buffer cannot serve the id and must be
        // bypassed. Getting this wrong reads off the end of the pool and
        // splices "undefined" into a value that goes on the wire.
        const oversized = otlpRandomHex(1024);

        expect(oversized).toHaveLength(2048);
        expect(oversized).toMatch(/^[0-9a-f]{2048}$/u);
    });

    it("draws uniformly across all 256 byte values", () => {
        expect.assertions(1);

        // Head sampling derives its verdict from the span id, so a skewed id
        // would skew which traces are kept. Chi-squared over 255 degrees of
        // freedom: the 99.9th percentile is ~345, so a uniform stream clears
        // this threshold essentially always and a biased one would not.
        // A typed array is zero-filled by construction, so no fill/from dance.
        const counts = new Uint32Array(256);
        let drawn = 0;

        while (drawn < 200_000) {
            const hex = otlpRandomHex(16);

            for (let index = 0; index < hex.length; index += 2) {
                const value = Number.parseInt(hex.slice(index, index + 2), 16);

                counts[value] = (counts[value] ?? 0) + 1;
            }

            drawn += 16;
        }

        const expected = drawn / 256;
        const chiSquared = counts.reduce((accumulator, count) => accumulator + ((count - expected) * (count - expected)) / expected, 0);

        expect(chiSquared).toBeLessThan(345);
    });
});
