/**
 * OTLP resource-attribute detection, bundler-inlined (like
 * {@link file://./otlp.ts}) so the worker sink (`@lunora/runtime`) and the
 * container exporter (`@lunora/container`) derive `service.version`,
 * `deployment.environment`, `host.name` and friends from ONE policy instead of
 * two hand-mirrored copies that drift.
 *
 * The two consumers read their environment differently — a Worker gets a bindings
 * object handed to `fetch`, a container reads `process.env` — so the environment
 * is injected as a {@link ResourceEnvReader} rather than baked in. That keeps this
 * module pure (no `process`, no globals) and makes every branch testable by
 * passing a plain map.
 *
 * The detectors are deliberately split by *where they can fire* rather than
 * bundled behind a flag: a Worker has no `HOSTNAME` and no pid, and a container
 * has no `request.cf`, so a single combined detector would spend a dozen probes
 * on branches that cannot hit. Callers compose only the ones their host can
 * satisfy.
 *
 * Keep this genuinely zero-dependency (only built-ins) so inlining stays sound.
 */
import type { OtlpResourceAttributes } from "./otlp";

/**
 * Reads one environment value by name, or `undefined` when absent. Lets a Worker
 * (bindings object), a container (`process.env`), and a test (plain object) share
 * one detector.
 */
type ResourceEnvReader = (key: string) => string | undefined;

/** Read a string property off a loosely-typed object (e.g. `request.cf`). */
const stringProperty = (object: unknown, key: string): string | undefined => {
    if (typeof object !== "object" || object === null) {
        return undefined;
    }

    const value = (object as Record<string, unknown>)[key];

    return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * Build a reader over a bindings-style bag. Non-string and empty values read as
 * absent, so a binding object (which holds KV namespaces, secrets stores and
 * other non-string values alongside plain vars) yields only real strings.
 *
 * With ONE exception, because the value we most want is behind it: a Cloudflare
 * `version_metadata` binding is an OBJECT (`{ id, tag, timestamp }`), not a
 * string, so a strict string reader made `CF_VERSION_METADATA` unreadable —
 * `service.version` auto-detection could never fire for the platform it was
 * written for. A version-shaped object resolves to its human `tag` when the
 * deployment set one, else the version `id`.
 */
const readerFromRecord =
    (environment: Record<string, unknown> | undefined): ResourceEnvReader =>
    (key) => {
        const value = environment?.[key];

        if (typeof value === "string") {
            return value.length > 0 ? value : undefined;
        }

        return stringProperty(value, "tag") ?? stringProperty(value, "id");
    };

/**
 * Service identity every host can report: `service.version` from the usual
 * CI/deploy variables, and `deployment.environment` from the usual environment
 * markers. Ordered most-specific-first so an explicit `SERVICE_VERSION` beats a
 * platform-injected commit sha.
 */
const detectServiceResource = (read: ResourceEnvReader): OtlpResourceAttributes => {
    const detected: OtlpResourceAttributes = {};

    const serviceVersion = read("SERVICE_VERSION") ?? read("CF_VERSION_METADATA") ?? read("VERCEL_GIT_COMMIT_SHA") ?? read("GITHUB_SHA") ?? read("COMMIT_SHA");

    if (serviceVersion !== undefined) {
        detected["service.version"] = serviceVersion;
    }

    const deploymentEnvironment = read("DEPLOYMENT_ENVIRONMENT") ?? read("ENVIRONMENT") ?? read("NODE_ENV");

    if (deploymentEnvironment !== undefined) {
        detected["deployment.environment"] = deploymentEnvironment;
    }

    return detected;
};

/**
 * Host / process identity for a long-lived OS process: `host.name`,
 * `k8s.pod.name`, and `process.pid`.
 *
 * `pid` is a parameter rather than a `process.pid` read so this stays pure and so
 * a Worker — which has no meaningful pid — simply never passes one. `k8s.pod.name`
 * is gated on `KUBERNETES_SERVICE_HOST` because `HOSTNAME` is the pod name only
 * when actually running under Kubernetes; elsewhere it is just the machine name
 * and is already reported as `host.name`.
 */
const detectHostResource = (read: ResourceEnvReader, pid?: number): OtlpResourceAttributes => {
    const detected: OtlpResourceAttributes = {};
    const hostName = read("HOSTNAME") ?? read("COMPUTERNAME");

    if (hostName !== undefined) {
        detected["host.name"] = hostName;
    }

    // The `KUBERNETES_SERVICE_HOST` gate belongs to the `HOSTNAME` FALLBACK only.
    // Wrapping the explicit branch in it too dropped `k8s.pod.name` for anyone who
    // set `KUBERNETES_POD_NAME` directly — the very variable that says "this is a
    // pod name" — on any host that does not also inject the in-cluster service
    // env (a `downwardAPI` value on a non-cluster runner, a sidecar-less agent).
    const podName = read("KUBERNETES_POD_NAME") ?? (read("KUBERNETES_SERVICE_HOST") === undefined ? undefined : read("HOSTNAME"));

    if (podName !== undefined) {
        detected["k8s.pod.name"] = podName;
    }

    if (pid !== undefined && Number.isFinite(pid)) {
        detected["process.pid"] = pid;
    }

    return detected;
};

/**
 * Cloudflare placement: `cloud.provider` plus `cloud.region` from the colo the
 * request landed in. `cf` is the inbound `Request.cf` bag (typed `unknown` so
 * this file needs no Cloudflare types); the env fallbacks cover paths that carry
 * no request, such as a cron or queue consumer.
 */
const detectCloudflareResource = (read: ResourceEnvReader, cf?: unknown): OtlpResourceAttributes => {
    const isCloudflare = cf !== undefined || read("CLOUDFLARE") !== undefined || read("CF_ACCOUNT_ID") !== undefined;

    if (!isCloudflare) {
        return {};
    }

    const detected: OtlpResourceAttributes = { "cloud.provider": "cloudflare" };
    const colo = stringProperty(cf, "colo") ?? read("CF_COLO") ?? read("CLOUDFLARE_COLO");

    if (colo !== undefined) {
        detected["cloud.region"] = colo;
    }

    return detected;
};

/**
 * Merge attribute bags left to right, so **later bags win** on collision. This is
 * the precedence every exporter wants: detected values are the weakest, explicit
 * configuration overrides them, and a caller's `resourceAttributes` overrides
 * everything. Empty bags are skipped, and merging nothing returns a fresh object
 * so callers can never alias a shared one.
 */
const mergeResourceAttributes = (...bags: (OtlpResourceAttributes | undefined)[]): OtlpResourceAttributes => {
    const merged: OtlpResourceAttributes = {};

    for (const bag of bags) {
        if (bag === undefined) {
            continue;
        }

        for (const [key, value] of Object.entries(bag)) {
            merged[key] = value;
        }
    }

    return merged;
};

export type { ResourceEnvReader };
export { detectCloudflareResource, detectHostResource, detectServiceResource, mergeResourceAttributes, readerFromRecord };
