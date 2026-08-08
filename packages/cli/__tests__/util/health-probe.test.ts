import { describe, expect, it, vi } from "vitest";

import type { HealthFetch } from "../../src/util/health-probe";
import { HEALTH_PATH, HEALTH_READY_PATH, joinHealthUrl, probeHealth } from "../../src/util/health-probe";

/** No real waiting between retries — the delay is injected in every test here. */
const noSleep = async (): Promise<void> => {};

describe("joinHealthUrl", () => {
    it("does not double the slash on a base URL that ends in one", () => {
        expect.assertions(2);

        expect(joinHealthUrl("https://app.workers.dev/")).toBe("https://app.workers.dev/_lunora/health");
        expect(joinHealthUrl("https://app.workers.dev", HEALTH_READY_PATH)).toBe("https://app.workers.dev/_lunora/health/ready");
    });
});

describe("probeHealth", () => {
    it("is green on a 2xx and asks only once by default", async () => {
        expect.assertions(3);

        const fetchImpl = vi.fn<HealthFetch>(async () => {
            return { ok: true, status: 200 };
        });

        const result = await probeHealth({ baseUrl: "https://app.workers.dev", fetchImpl });

        expect(result.error).toBeUndefined();
        expect(result.url).toBe("https://app.workers.dev/_lunora/health");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("retries up to the attempt budget and passes once the deploy propagates", async () => {
        expect.assertions(2);

        // The reason the budget exists: a version that isn't serving yet answers
        // 503 on the first probe and 200 moments later.
        const responses = [
            { ok: false, status: 503 },
            { ok: false, status: 503 },
            { ok: true, status: 200 },
        ];
        const fetchImpl = vi.fn<HealthFetch>(async () => responses.shift() ?? { ok: true, status: 200 });

        const result = await probeHealth({ attempts: 5, baseUrl: "https://app.workers.dev", fetchImpl, sleep: noSleep });

        expect(result.error).toBeUndefined();
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("reports the last failure after exhausting the budget", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<HealthFetch>(async () => {
            return { ok: false, status: 503 };
        });

        const result = await probeHealth({ attempts: 3, baseUrl: "https://app.workers.dev", fetchImpl, sleep: noSleep });

        expect(result.error).toContain("returned HTTP 503");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it("falls back to the next path when the first 404s (an older deployment has no readiness gate)", async () => {
        expect.assertions(3);

        const fetchImpl = vi.fn<HealthFetch>(async (url: string) => (url.endsWith("/ready") ? { ok: false, status: 404 } : { ok: true, status: 200 }));

        const result = await probeHealth({ baseUrl: "https://app.workers.dev", fetchImpl, paths: [HEALTH_READY_PATH, HEALTH_PATH] });

        expect(result.error).toBeUndefined();
        expect(result.url).toBe("https://app.workers.dev/_lunora/health");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does not fall through on a non-404 — a 503 on the readiness gate is the answer", async () => {
        expect.assertions(2);

        const fetchImpl = vi.fn<HealthFetch>(async () => {
            return { ok: false, status: 503 };
        });

        const result = await probeHealth({ baseUrl: "https://app.workers.dev", fetchImpl, paths: [HEALTH_READY_PATH, HEALTH_PATH] });

        expect(result.error).toContain("/_lunora/health/ready returned HTTP 503");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports a transport failure as red without throwing", async () => {
        expect.assertions(1);

        const fetchImpl = vi.fn<HealthFetch>(async () => {
            throw new Error("getaddrinfo ENOTFOUND");
        });

        const result = await probeHealth({ baseUrl: "https://app.workers.dev", fetchImpl, sleep: noSleep });

        expect(result.error).toContain("could not reach https://app.workers.dev/_lunora/health (getaddrinfo ENOTFOUND)");
    });
});
