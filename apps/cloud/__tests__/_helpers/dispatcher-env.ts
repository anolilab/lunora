import type { Mock } from "vitest";
import { vi } from "vitest";

/**
 * The `DISPATCHER.get` shape the dispatcher calls, mirrored from its own
 * `DispatchNamespace`: a change to the dispatch call breaks the tests that use
 * this, instead of letting their doubles drift.
 */
type DispatchGet = (
    name: string,
    args?: unknown,
    options?: { limits?: { cpuMs?: number; subRequests?: number }; outbound?: { lineage?: string } },
) => { fetch: (request: Request) => Promise<Response> };

/** The environment a test hands the dispatcher: the namespace, the app domain, and any other binding. */
interface TestDispatcherEnv {
    [binding: string]: unknown;
    DISPATCHER: { get: Mock<DispatchGet> };
    LUNORA_APP_DOMAIN: string;
    LUNORA_ENVIRONMENT?: string;
}

interface DispatcherEnvOptions {
    /** Every other binding, passed through as given. */
    [binding: string]: unknown;
    /** Opt in to the `development` free tier: the only environment served without a control plane. */
    development?: boolean;
    /** A dispatch namespace to use as-is, for a test that asserts on its calls. */
    dispatch?: Mock<DispatchGet>;
    /** The tenant's response; the namespace's `get` hands it out. Defaults to a plain 200. */
    tenant?: (request: Request) => Promise<Response>;
}

/** The tenant answer when a test does not name one. */
const defaultTenant = (): Promise<Response> => Promise.resolve(new Response("tenant body", { status: 200 }));

/**
 * The dispatcher's environment for a test: a dispatch namespace, the app domain, and every
 * other binding passed through as given. `LUNORA_ENVIRONMENT` is absent unless `development`
 * is set, so a test that forgets the control plane fails closed instead of passing by accident.
 */
const dispatcherEnv = (options: DispatcherEnvOptions = {}): TestDispatcherEnv => {
    const { development = false, dispatch, tenant = defaultTenant, ...bindings } = options;

    return {
        DISPATCHER: { get: dispatch ?? vi.fn<DispatchGet>().mockReturnValue({ fetch: tenant }) },
        LUNORA_APP_DOMAIN: "lunora.app",
        ...(development ? { LUNORA_ENVIRONMENT: "development" } : {}),
        ...bindings,
    };
};

export type { DispatcherEnvOptions, DispatchGet, TestDispatcherEnv };
export { dispatcherEnv };
