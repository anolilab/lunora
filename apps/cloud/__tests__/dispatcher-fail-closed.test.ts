import type { MockInstance } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LINEAGE_HEADER, signLineage } from "../src/dispatcher/lineage";
import type { AnalyticsEngineDatasetLike } from "../src/targets/cloudflare-wfp/analytics";
import { dispatcherEnv } from "./_helpers/dispatcher-env";

/**
 * Fail-closed without a control plane (plan 475). Outside `development` the
 * dispatcher refuses every request when it cannot reach the control plane, and
 * refuses a lineage header it cannot verify. Under `development` it keeps the
 * free tier, which is the only way a tenant is served unverified.
 *
 * Each case loads a fresh dispatcher (`vi.resetModules`), so the resolver caches
 * and the logged-once set start clear without a unique control-plane URL per case.
 */

const SECRET = "lineage-fail-closed-secret"; // gitleaks:allow -- fabricated test secret
const TOKEN = "cp_token_fail_closed"; // gitleaks:allow -- fabricated fixture, not a credential
const CONTROL_PLANE = "https://cp-fail-closed.example";

const controlPlane = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname === "/v1/tenants/plan") {
        return Response.json({ plan: "pro" });
    }

    return Response.json({});
});

vi.stubGlobal("fetch", controlPlane);

/** A dispatcher loaded fresh, so the per-isolate "logged once" flag starts clear. */
const loadDispatcher = async () => {
    vi.resetModules();

    const worker = await import("../src/dispatcher/worker");

    return worker.default;
};

const tenantFetch = vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response("tenant body", { status: 200 })));

const writeDataPoint = vi.fn<AnalyticsEngineDatasetLike["writeDataPoint"]>();

type Overrides = {
    CONTROL_PLANE_TOKEN?: string;
    CONTROL_PLANE_URL?: string;
    LUNORA_CELL?: string;
    LUNORA_ENVIRONMENT?: string;
    LUNORA_LINEAGE_SECRET?: string;
};

/** The dispatcher's environment with the given overrides; `undefined` removes a key, as an unset binding would be. */
const environment = (overrides: Overrides) => dispatcherEnv({ PLATFORM_METRICS: { writeDataPoint }, tenant: tenantFetch, ...overrides });

/** A deployment with no control plane: both settings unset. */
const unconfigured = (overrides: Overrides = {}): Overrides => {
    return { CONTROL_PLANE_TOKEN: undefined, CONTROL_PLANE_URL: undefined, ...overrides };
};

/** A deployment with a control plane and the lineage secret set. */
const configured = (overrides: Overrides = {}): Overrides => {
    return {
        CONTROL_PLANE_TOKEN: TOKEN,
        CONTROL_PLANE_URL: CONTROL_PLANE,
        LUNORA_ENVIRONMENT: "production",
        LUNORA_LINEAGE_SECRET: SECRET,
        ...overrides,
    };
};

/** The refusal log, silenced for one case. The spy is restored after each case. */
let errorLog: MockInstance<typeof console.error> | undefined;

const silenceErrorLog = (): MockInstance<typeof console.error> => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    return errorLog;
};

/** The counter rows only: the dispatcher also writes a `dispatch` row for every request, so count by kind. */
const refusalRows = (): unknown[] => writeDataPoint.mock.calls.map(([point]) => point).filter((point) => point?.blobs?.[0] === "misconfigured");

/** The outcome of every `recursion` row, so a test can assert that none is `forged`. */
const recursionOutcomes = (): unknown[] =>
    writeDataPoint.mock.calls
        .map(([point]) => point)
        .filter((point) => point?.blobs?.[0] === "recursion")
        .map((point) => point?.blobs?.[2]);

afterEach(() => {
    tenantFetch.mockClear();
    writeDataPoint.mockClear();
    controlPlane.mockClear();
    errorLog?.mockRestore();
    errorLog = undefined;
});

describe("dispatcher refuses without a control plane outside development", () => {
    it.each(["production", "staging"])("refuses every request in %s with 503 and the stable error code, without running the tenant", async (deployment) => {
        silenceErrorLog();

        const dispatcher = await loadDispatcher();
        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/"), environment(unconfigured({ LUNORA_ENVIRONMENT: deployment })));

        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("30");
        await expect(response.json()).resolves.toMatchObject({ error: "control_plane_unconfigured" });
        expect(tenantFetch).not.toHaveBeenCalled();
    });

    it("names the missing URL when only the token is set, and the missing token when only the URL is set", async () => {
        silenceErrorLog();

        const dispatcher = await loadDispatcher();

        const noUrl = await dispatcher.fetch(
            new Request("https://acme.lunora.app/"),
            environment(unconfigured({ CONTROL_PLANE_TOKEN: TOKEN, LUNORA_ENVIRONMENT: "production" })),
        );
        const noToken = await dispatcher.fetch(
            new Request("https://acme.lunora.app/"),
            environment(unconfigured({ CONTROL_PLANE_URL: CONTROL_PLANE, LUNORA_ENVIRONMENT: "production" })),
        );

        await expect(noUrl.json()).resolves.toMatchObject({ message: "control plane URL (CONTROL_PLANE_URL) not set for this environment" });
        await expect(noToken.json()).resolves.toMatchObject({ message: "control plane token (CONTROL_PLANE_TOKEN secret) not set for this environment" });
    });

    it("refuses when LUNORA_ENVIRONMENT is absent, because an unrecognised value fails closed", async () => {
        silenceErrorLog();

        const dispatcher = await loadDispatcher();
        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/"), environment(unconfigured()));

        expect(response.status).toBe(503);
        expect(tenantFetch).not.toHaveBeenCalled();
    });

    it("refuses a custom domain too, rather than routing it around the gate", async () => {
        silenceErrorLog();

        const dispatcher = await loadDispatcher();
        const response = await dispatcher.fetch(new Request("https://go.redirect.example/"), environment(unconfigured({ LUNORA_ENVIRONMENT: "production" })));

        expect(response.status).toBe(503);
        expect(response.headers.get("location")).toBeNull();
    });

    it("writes a counter row for every refusal", async () => {
        silenceErrorLog();

        const dispatcher = await loadDispatcher();

        await dispatcher.fetch(new Request("https://acme.lunora.app/"), environment(unconfigured({ LUNORA_CELL: "eu-1", LUNORA_ENVIRONMENT: "production" })));

        expect(refusalRows()).toStrictEqual([{ blobs: ["misconfigured", "eu-1", "control_plane"], doubles: [1], indexes: ["misconfigured"] }]);
    });

    it("logs the refusal once per isolate, not once per request", async () => {
        const dispatcher = await loadDispatcher();
        const error = silenceErrorLog();
        const unset = environment(unconfigured({ LUNORA_ENVIRONMENT: "production" }));

        await dispatcher.fetch(new Request("https://a.lunora.app/"), unset);
        await dispatcher.fetch(new Request("https://b.lunora.app/"), unset);

        expect(error).toHaveBeenCalledTimes(1);
        expect(refusalRows()).toHaveLength(2);
    });

    it("serves a configured production dispatcher exactly as before", async () => {
        const dispatcher = await loadDispatcher();
        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/"), environment(configured()));

        expect(response.status).toBe(200);
        expect(tenantFetch).toHaveBeenCalledTimes(1);
    });

    it("keeps the free tier under development with no control plane at all", async () => {
        const dispatcher = await loadDispatcher();
        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/"), environment(unconfigured({ LUNORA_ENVIRONMENT: "development" })));

        expect(response.status).toBe(200);
        expect(tenantFetch).toHaveBeenCalledTimes(1);
        expect(refusalRows()).toHaveLength(0);
    });
});

describe("dispatcher refuses a lineage header it cannot verify outside development", () => {
    const withLineage = (host = "acme.lunora.app"): Request => new Request(`https://${host}/`, { headers: { [LINEAGE_HEADER]: "v1.0.forged.0.0" } });

    it("refuses a lineage header when the secret is missing, without running the tenant", async () => {
        const dispatcher = await loadDispatcher();
        const error = silenceErrorLog();
        const response = await dispatcher.fetch(withLineage(), environment(configured({ LUNORA_ENVIRONMENT: "staging", LUNORA_LINEAGE_SECRET: undefined })));

        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("30");
        await expect(response.json()).resolves.toMatchObject({ error: "lineage_unverifiable" });
        expect(tenantFetch).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.stringContaining("LUNORA_LINEAGE_SECRET"));
    });

    it("refuses a lineage header before routing, so an unknown host answers 503 and not 404", async () => {
        const dispatcher = await loadDispatcher();
        silenceErrorLog();
        const response = await dispatcher.fetch(
            withLineage("nobody.unknown.example"),
            environment(configured({ LUNORA_ENVIRONMENT: "staging", LUNORA_LINEAGE_SECRET: undefined })),
        );

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ error: "lineage_unverifiable" });
        expect(tenantFetch).not.toHaveBeenCalled();
    });

    it("counts a missing secret as a misconfiguration, not a forged header, and logs it once per isolate", async () => {
        const dispatcher = await loadDispatcher();
        const error = silenceErrorLog();
        const staging = environment(configured({ LUNORA_ENVIRONMENT: "staging", LUNORA_LINEAGE_SECRET: undefined }));

        await dispatcher.fetch(withLineage("a.lunora.app"), staging);
        await dispatcher.fetch(withLineage("b.lunora.app"), staging);

        expect(error).toHaveBeenCalledTimes(1);
        expect(refusalRows()).toStrictEqual([
            { blobs: ["misconfigured", "default", "lineage_secret"], doubles: [1], indexes: ["misconfigured"] },
            { blobs: ["misconfigured", "default", "lineage_secret"], doubles: [1], indexes: ["misconfigured"] },
        ]);
        expect(recursionOutcomes()).not.toContain("forged");
    });

    it("lets ordinary traffic through with the secret missing, since it carries no lineage header", async () => {
        const dispatcher = await loadDispatcher();
        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/"), environment(configured({ LUNORA_LINEAGE_SECRET: undefined })));

        expect(response.status).toBe(200);
    });

    it("still ignores the header under development, as before", async () => {
        const dispatcher = await loadDispatcher();
        const response = await dispatcher.fetch(withLineage(), environment(unconfigured({ LUNORA_ENVIRONMENT: "development" })));

        expect(response.status).toBe(200);
    });

    it("still verifies a correctly signed header in production, so the chain depth is honoured", async () => {
        const dispatcher = await loadDispatcher();
        const signed = await signLineage(SECRET, { depth: 1, root: "0123456789abcdef0123456789abcdef" }, Date.now()); // eslint-disable-line no-secrets/no-secrets -- a test chain id, not a secret;
        const response = await dispatcher.fetch(new Request("https://acme.lunora.app/", { headers: { [LINEAGE_HEADER]: signed } }), environment(configured()));

        expect(response.status).toBe(200);
        expect(tenantFetch).toHaveBeenCalledTimes(1);
    });
});
