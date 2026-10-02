/**
 * The deploy core, transport-agnostic: validate a release, record its
 * deployment, converge it through the project's target driver, gate it on a
 * health check (reverting a failed one), and record it live — reporting every
 * step as a {@link ReleaseFrame}. `POST /v1/deploy` (`./handler`) streams the
 * frames as NDJSON; a git build (`src/builds/release.ts`) writes them into the
 * build's log. One pipeline, two callers.
 *
 * Pure: all I/O is behind {@link DeployBackend} + the injected driver/
 * scheduler/store, so the whole flow is unit-testable with fakes. The Worker
 * wiring is `src/deploy/routes/deploy.ts`.
 */
import { isLunoraError } from "@lunora/errors";

import type { AssetsUpload, DeployKind, DeployManifest, TenantDeploymentSpec } from "../provision-contract";
import type { TargetDriver } from "../targets/driver";
import type { Placement } from "../targets/placement";
import { randomSecret } from "./keys";
import { parsePayload } from "./manifest-parse";
import type { DeployProgress } from "./orchestrator";
import { runDeployment } from "./orchestrator";
import type { ReleaseBackend, ReleaseDeps } from "./release";
import { decodeBundle, reprovision, resolveReleaseSpec } from "./release";

export interface DeployTarget {
    organizationId: string;
    projectId?: string;
    type: DeployKind;
}

/**
 * The control-plane operations the deploy flow needs. Every call carries the
 * presented deploy key so the underlying mutations can authorize by key (the
 * deploy request has no user session).
 */
export interface DeployBackend extends ReleaseBackend {
    // Record this now-healthy deployment as live and supersede the previous live
    // release of its alias (GAPS.md A1). Omit to skip pointer management.
    activateDeployment?: (input: { deploymentId: string; key: string }) => Promise<void>;
    /** Record a queued deployment; `previousDeploymentId` is the release of the same alias live before it, if any. */
    createDeployment: (input: {
        adminToken: string;
        branch?: string;
        /** The tenant's compiled cron expressions for the WfP cron fan-out (§2.4). */
        cronSpecs?: string[];
        key: string;
        kind: DeployKind;
        organizationId: string;
        projectId: string; // secret-scanner:allow -- domain field name
        scriptName: string;
    }) => Promise<{ deploymentId: string; previousDeploymentId?: string; version?: number }>;
    updateStatus: (input: {
        bundleHash?: string;
        deploymentId: string;
        key: string;
        status: "failed" | "live" | "provisioning" | "verifying";
        url?: string;
    }) => Promise<void>;
    verifyKey: (key: string) => Promise<DeployTarget | null>;
}

export interface DeployHandlerDeps extends ReleaseDeps {
    /**
     * Record the deployment's outcome for platform self-observability
     * (GAPS.md E1 — the studio observes tenants; nothing observed us).
     *
     * A port rather than a direct call so this module stays free of `env` and
     * `fetch`, and so a test can assert what was recorded without a network
     * double. Fire-and-forget by contract: the implementation must not throw
     * and must not be awaited on the deploy path.
     */
    analytics?: (event: string, properties: Record<string, boolean | number | string>) => void;
    backend: DeployBackend;

    /**
     * Probe the project's URL once the release is on its Worker (GAPS.md A1).
     * `false` fails the deployment and re-provisions the previous live release.
     * Omit to skip health gating.
     */
    healthCheck?: (url: string) => Promise<boolean>;
}

/**
 * Put the previous live release back after a release failed its health check.
 *
 * The check runs AFTER cutover — the project has one Worker, and Workers for
 * Platforms cannot stage a user Worker's version — so a failed check means the
 * broken release is already serving. There is no previous release on a
 * project's first deploy, and then the failed release stays up: it is all there
 * is. Reports each step as an NDJSON event; never throws.
 */
const revertFailedRelease = async (
    input: { deploymentId: string; key: string; organizationId: string; previousDeploymentId: string | undefined },
    deps: ReleaseDeps,
    write: (frame: ReleaseFrame) => void,
): Promise<void> => {
    const { deploymentId, previousDeploymentId } = input;

    if (previousDeploymentId === undefined) {
        write({ deploymentId, event: "not_reverted", reason: "no previous release to revert to" });

        return;
    }

    write({ deploymentId, event: "reverting", to: previousDeploymentId });

    try {
        await reprovision({ deploymentId: previousDeploymentId, key: input.key, organizationId: input.organizationId }, deps);
        write({ deploymentId, event: "reverted", to: previousDeploymentId });
    } catch (error) {
        write({ deploymentId, error: error instanceof Error ? error.message : String(error), event: "revert_failed", to: previousDeploymentId });
    }
};

/** What a release ships: the deploy request body minus its credential, whichever transport carried it. */
export interface ReleaseRequest {
    /** Static files behind the manifest's `assets` binding. Validated by `parsePayload` (`./manifest-parse`). */
    assets?: unknown;
    branch?: string;
    /** Base64-encoded prebuilt worker module (built by the app's pipeline or the build box — never here). */
    bundle?: string;
    /** The tenant's cron expressions (wrangler `triggers.crons`) for the fan-out (§2.4). Untrusted. */
    cronSpecs?: unknown;
    /** Already checked against the caller's ceiling — {@link startRelease} does not re-rank it. */
    kind: DeployKind;
    /** The Worker's binding manifest. `unknown` because it is untrusted wire data; `parsePayload` validates it. */
    manifest?: unknown;
    projectId: string;
    scriptName: string;
}

/** Who asked: the deploy key every backend call authorizes by, and the organization it resolved to. */
export interface ReleaseCaller {
    key: string;
    organizationId: string;
}

/** How a release ended. `error` is set exactly when `status` is `failed`. */
export interface ReleaseOutcome {
    deploymentId: string;
    error?: string;
    status: "failed" | "live";
    url?: string;
}

/**
 * One progress frame: an NDJSON line on `POST /v1/deploy`, a `buildLogs` line
 * for a git build. A closed union, so every reader of the stream (the CLI's
 * printer, `describeReleaseFrame` for git builds) is told when a frame is added.
 */
export type ReleaseFrame =
    /** An orchestrator phase — the deployment-state transitions, `failed` carrying its error. */
    | (DeployProgress & { deploymentId: string })
    /** The release's last frame. */
    | { deploymentId: string; done: true; status: ReleaseOutcome["status"] }
    | { deploymentId: string; error: string; event: "revert_failed"; to: string }
    | { deploymentId: string; event: "accepted" | "released" }
    | { deploymentId: string; event: "not_reverted"; reason: string }
    | { deploymentId: string; event: "reverted" | "reverting"; to: string }
    /** One progress line from the target while it converges (`celld-vps`: the box's job output). */
    | { deploymentId: string; log: string };

/**
 * A release that passed validation and has a deployment row, ready to run — or
 * the reason it was refused before anything was recorded. Split in two because
 * the HTTP route answers the refusal as a status code and the run as a stream.
 */
export type StartedRelease =
    { deploymentId: string; run: (write: (frame: ReleaseFrame) => void) => Promise<ReleaseOutcome> } | { error: string; status: 400 | 403 | 409 | 501 };

/** What {@link runRelease} needs to know about a release it was handed. */
interface RecordedRelease {
    adminToken: string;
    assets: AssetsUpload | undefined;
    bundle: ArrayBuffer;
    caller: ReleaseCaller;
    cronSpecs: string[] | undefined;
    deploymentId: string;
    /** The project's target driver — built before the row was recorded, so a target without one refused the release. */
    driver: TargetDriver;
    encodedBundle: string;
    kind: DeployKind;
    manifest: DeployManifest;
    /** Where the release converges — what decides whose budget paces it. */
    placement: Placement;
    previousDeploymentId: string | undefined;
    projectId: string;
    scriptName: string;
}

const withUrl = (url: string | undefined): { url?: string } => (url === undefined ? {} : { url });

/**
 * Forward each orchestrator phase as a frame, and record the ones that are
 * deployment states on the row. `onUrl` learns the Worker's URL as soon as a
 * phase carries it, so a release that fails its health check still reports where.
 */
const reportProgress =
    (release: { deploymentId: string; deps: DeployHandlerDeps; key: string; write: (frame: ReleaseFrame) => void }, onUrl: (url: string) => void) =>
    async (progress: DeployProgress): Promise<void> => {
        const { deploymentId, deps, key, write } = release;

        if (progress.url !== undefined) {
            onUrl(progress.url);
        }

        write({ ...progress, deploymentId });

        if (progress.phase === "provisioning" || progress.phase === "verifying" || progress.phase === "live" || progress.phase === "failed") {
            await deps.backend.updateStatus({ bundleHash: progress.bundleHash, deploymentId, key, status: progress.phase, url: progress.url });
        }
    };

/**
 * Drive one recorded release: store it, resolve its secrets, provision it, gate
 * it on a health check (reverting a failed one), and record it live. Reports
 * every step through `write`; never throws — a failure is the outcome.
 */
const runRelease = async (release: RecordedRelease, deps: DeployHandlerDeps, write: (frame: ReleaseFrame) => void): Promise<ReleaseOutcome> => {
    const { assets, caller, deploymentId, kind, manifest } = release;
    const { key, organizationId } = caller;
    let url: string | undefined;

    /**
     * The one terminal-failure path: emit the failed phase + done frames and
     * best-effort mark the row failed. Extracted because three call sites had to
     * do every step in order, and a missed one strands the row mid-flight with
     * the client still hanging.
     */
    const fail = async (error: unknown, fallback: string): Promise<ReleaseOutcome> => {
        const message = error instanceof Error ? error.message : fallback;

        write({ deploymentId, error: message, phase: "failed" });

        try {
            await deps.backend.updateStatus({ deploymentId, key, status: "failed" });
        } catch {
            // The status write is the likeliest thing to have just failed;
            // reporting the failure downstream matters more than recording it.
        }

        write({ deploymentId, done: true, status: "failed" });

        return { deploymentId, error: message, status: "failed", ...withUrl(url) };
    };

    write({ deploymentId, event: "accepted" });

    // Stored BEFORE anything touches the Worker: this copy is what a later
    // rollback — or the revert below — puts back, so a release that is not
    // stored must never go live.
    try {
        await deps.releases.put(deploymentId, { ...(assets ? { assets } : {}), bundle: release.encodedBundle, manifest });
    } catch (error) {
        return fail(new Error(`failed to store the release: ${error instanceof Error ? error.message : String(error)}`), "");
    }

    // A decrypt failure (e.g. a corrupt secret or a rotated master key) must
    // surface as a failed deployment, not leave the row stuck in `accepted`.
    let spec: TenantDeploymentSpec;

    try {
        spec = await resolveReleaseSpec(
            {
                adminToken: release.adminToken,
                alias: release.scriptName,
                assets,
                bundle: release.bundle,
                ...(release.cronSpecs ? { cronSpecs: release.cronSpecs } : {}),
                deploymentId,
                key,
                kind,
                manifest,
                organizationId,
                projectId: release.projectId, // secret-scanner:allow -- domain field name
            },
            deps,
        );
    } catch (error) {
        return fail(error, "failed to resolve tenant secrets");
    }

    const { healthCheck } = deps;

    let outcome: Awaited<ReturnType<typeof runDeployment>>;

    try {
        outcome = await runDeployment(spec, {
            driver: release.driver,
            // The target's own progress lines join the stream (a box's job output); a target that reports none adds none.
            onLine: (line) => {
                write({ deploymentId, log: line });
            },
            onProgress: reportProgress({ deploymentId, deps, key, write }, (progressUrl) => {
                url = progressUrl;
            }),
            scheduler: deps.pacer.schedulerFor(release.placement),
            ...(healthCheck ? { verify: healthCheck } : {}),
        });
    } catch (error) {
        // `runDeployment` converts driver/scheduler faults into
        // `{ status: "failed" }` itself, so reaching here means the *callback*
        // threw — an `updateStatus` write that failed, most likely. Without
        // this the row is stranded mid-flight in `accepted`/`provisioning`
        // forever, and an HTTP client hangs instead of seeing a failure.
        return fail(error, "deployment failed");
    }

    if (outcome.status === "failed" && outcome.provisioned) {
        await revertFailedRelease({ deploymentId, key, organizationId, previousDeploymentId: release.previousDeploymentId }, deps, write);
    }

    // Health-checked release: record it live and supersede the previous
    // one (GAPS.md A1). An activation failure downgrades the release to
    // failed, but the Worker already runs it — the record is what lags.
    if (outcome.status === "live" && deps.backend.activateDeployment) {
        try {
            await deps.backend.activateDeployment({ deploymentId, key });
            write({ deploymentId, event: "released" });
        } catch (error) {
            return fail(error, "activation failed");
        }
    }

    // Outcome, not progress: one event per deploy, carrying ids and a
    // status. Never the script, its bindings, or the tenant's URL.
    deps.analytics?.("cloud_deployment_finished", { deploymentId, kind, status: outcome.status });

    write({ deploymentId, done: true, status: outcome.status });

    return outcome.status === "live"
        ? { deploymentId, status: "live", url: outcome.result.url }
        : { deploymentId, error: outcome.error, status: "failed", ...withUrl(url) };
};

/**
 * The project's placement and the driver for it, or why the release is
 * refused: a project placed on another cell (409), a target with no driver yet
 * (501), a project the caller cannot see (403).
 */
const projectDriver = async (
    projectId: string, // secret-scanner:allow -- domain field name
    caller: ReleaseCaller,
    deps: DeployHandlerDeps,
): Promise<{ driver: TargetDriver; placement: Placement } | { error: string; status: 403 | 409 | 501 }> => {
    try {
        const placement = await deps.backend.placement({ key: caller.key, organizationId: caller.organizationId, projectId });

        return { driver: deps.driverFor(placement), placement };
    } catch (error) {
        const message = error instanceof Error ? error.message : "this project cannot be placed";
        const status = isLunoraError(error) ? error.status : 403;

        return { error: message, status: status === 409 || status === 501 ? status : 403 };
    }
};

/**
 * The deploy core, transport-agnostic: validate a release, record its
 * deployment, and hand back the run. `POST /v1/deploy` calls it with the
 * presented deploy key and streams the run as NDJSON; a git build
 * (`src/builds/release.ts`) calls it with a key the platform minted for that one
 * release and writes the run into the build's log. Same validation, same
 * stored release, same health gate and revert — one pipeline, two callers.
 *
 * Every refusal happens before a deployment row exists or anything is provisioned.
 */
export const startRelease = async (request: ReleaseRequest, caller: ReleaseCaller, deps: DeployHandlerDeps): Promise<StartedRelease> => {
    // The worker bundle is prebuilt (the app's Vite pipeline, or the build box);
    // deploying without one would provision an empty module, so fail fast.
    if (!request.bundle) {
        return { error: "bundle is required (base64-encoded worker module)", status: 400 };
    }

    const encodedBundle = request.bundle;
    const bundle = decodeBundle(encodedBundle);

    if (!bundle) {
        return { error: "bundle is not valid base64", status: 400 };
    }

    // Placement and driver first: the project's target decides which binding
    // table the payload is validated against, a project placed on another cell
    // is refused here, and a target with no driver must refuse before anything
    // is recorded.
    const placed = await projectDriver(request.projectId, caller, deps);

    if ("error" in placed) {
        return placed;
    }

    const { driver, placement } = placed;
    const payload = parsePayload(request, request.scriptName, placement.target);

    if ("error" in payload) {
        return { error: payload.error, status: 400 };
    }

    const { assets, manifest } = payload.value;
    const { branch, kind, projectId, scriptName } = request;
    // Tenant cron expressions to fan out (§2.4). Defensive: only strings, capped.
    const cronSpecs = Array.isArray(request.cronSpecs) ? request.cronSpecs.filter((cron): cron is string => typeof cron === "string").slice(0, 50) : undefined;

    // The platform-minted tenant admin token: recorded on the deployment (for the
    // admin proxy) and set as the worker's LUNORA_ADMIN_TOKEN secret.
    const adminToken = randomSecret();

    let created: { deploymentId: string; previousDeploymentId?: string };

    try {
        created = await deps.backend.createDeployment({
            adminToken,
            branch,
            ...(cronSpecs && cronSpecs.length > 0 ? { cronSpecs } : {}),
            key: caller.key,
            kind,
            organizationId: caller.organizationId,
            projectId,
            scriptName,
        });
    } catch (error) {
        return { error: error instanceof Error ? error.message : "failed to record deployment", status: 403 };
    }

    const { deploymentId, previousDeploymentId } = created;

    return {
        deploymentId,
        run: (write) =>
            runRelease(
                {
                    adminToken,
                    assets,
                    bundle,
                    caller,
                    cronSpecs,
                    deploymentId,
                    driver,
                    encodedBundle,
                    placement,
                    kind,
                    manifest,
                    previousDeploymentId,
                    projectId,
                    scriptName,
                },
                deps,
                write,
            ),
    };
};
