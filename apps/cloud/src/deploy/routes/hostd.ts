/**
 * `lunora-hostd` releases on the control plane (plan 458 G17).
 *
 * - `POST /v1/hostd/releases` — `adminToken`: store a signed release envelope,
 *   verified against the pinned release keys first.
 * - `GET /v1/hostd/releases/:releaseId/manifest` — `boxKey`: a box fetches the
 *   envelope an `upgrade` job names, with a request signed by its key.
 * - `POST /v1/hostd/rollout` — `adminToken`: point boxes (named, or all) at a
 *   release and roll it out over their sessions, canary first — 202, run after
 *   the response.
 */
import type { D1DatabaseLike } from "@lunora/d1";

import { internal } from "../../../lunora/_generated/api.js";
import type { RolloutBox } from "../../../lunora/boxes";
import type { HostdReleaseView } from "../../../lunora/hostd-releases";
import { verifyReleaseEnvelope, versionsOf } from "../../boxes/hostd-releases";
import { manifestUrlOf, planHostdRollout, runHostdRollout, upgradeDispatch, withdrawDesiredRelease } from "../../boxes/rollout";
import { controlPlaneDatabase } from "../../d1-store";
import { matchRoutePath } from "../route-path";
import type { BoxRouteEnvironment } from "./boxes";
import { verifiedBoxRequest } from "./boxes";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";
import { requireAdminToken } from "./tenant-admin";

type HostdRouterEnv = BoxRouteEnvironment & RouterEnv & { LUNORA_ORIGIN_URL?: string };

/** The manifest path; `:releaseId` is a release id (`[A-Za-z0-9_-]`, the protocol's id alphabet). */
export const HOSTD_MANIFEST_PATH = "/v1/hostd/releases/:releaseId/manifest";

/**
 * `POST /v1/hostd/releases` — store a signed release. Body: `{ envelope, channel? }`,
 * where `envelope` is the published `manifest.json`. Refused unless it verifies
 * exactly as a box would verify it; a placeholder key verifies nothing.
 */
export const handleHostdReleaseRoute = async (request: Request, environment: HostdRouterEnv): Promise<Response> => {
    const unauthorized = requireAdminToken(request, environment);

    if (unauthorized) {
        return unauthorized;
    }

    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as null | { channel?: unknown; envelope?: unknown };

    if (body?.channel !== undefined && body.channel !== "stable" && body.channel !== "canary") {
        return jsonError(400, 'channel must be "stable" or "canary"');
    }

    const verified = await verifyReleaseEnvelope(body?.envelope);

    if (!verified.ok) {
        return jsonError(422, verified.reason);
    }

    const { envelope } = verified;

    try {
        const { created } = await context.runMutation<{ created: boolean }>(internal.hostd_releases.store, {
            ...(body?.channel === undefined ? {} : { channel: body.channel }),
            envelope: JSON.stringify(envelope),
            keyId: envelope.keyId,
            releaseId: envelope.manifest.releaseId,
            versions: versionsOf(envelope),
        });

        return Response.json({ created, releaseId: envelope.manifest.releaseId }, { status: created ? 201 : 200 });
    } catch (error) {
        return rejected(error, "release refused");
    }
};

/** `GET /v1/hostd/releases/:releaseId/manifest` — the signed envelope, to a box that signed its request. */
export const handleHostdManifestRoute = async (request: Request, environment: HostdRouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const releaseId = matchRoutePath(HOSTD_MANIFEST_PATH, new URL(request.url).pathname)?.["releaseId"];

    if (!environment.BOX_SESSION) {
        return jsonError(503, "this control plane does not serve boxes");
    }

    if ((await verifiedBoxRequest(request, environment)) === null) {
        return jsonError(401, "invalid box signature");
    }

    const envelope = releaseId === undefined ? null : await context.runQuery<null | string>(internal.hostd_releases.envelope, { releaseId });

    return envelope === null
        ? jsonError(404, "no such hostd release")
        : new Response(envelope, { headers: { "cache-control": "no-store", "content-type": "application/json" }, status: 200 });
};

interface RolloutBody {
    batchSize?: unknown;
    boxIds?: unknown;
    canarySize?: unknown;
    releaseId?: unknown;
}

const positiveInteger = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined);

/**
 * `POST /v1/hostd/rollout` — body `{ releaseId, boxIds?, canarySize?, batchSize? }`.
 * Sets `desiredReleaseId` on the named boxes (or every box that is not
 * revoked) — the durable intent — plans the upgrade of the ones online now,
 * and answers 202 with the batches, canary first. The run starts on the
 * request's `waitUntil`; the hourly sweep resumes whatever that run did not
 * reach, and boxes that are offline upgrade when they reconnect
 * (`src/boxes/rollout.ts`).
 */
export const handleHostdRolloutRoute = async (request: Request, environment: HostdRouterEnv): Promise<Response> => {
    const unauthorized = requireAdminToken(request, environment);

    if (unauthorized) {
        return unauthorized;
    }

    const context = requireContext(environment);
    const namespace = environment.BOX_SESSION;
    const origin = environment.LUNORA_ORIGIN_URL;

    if (!namespace || !origin || environment.DB == null) {
        return jsonError(503, "rollouts need BOX_SESSION, DB and LUNORA_ORIGIN_URL");
    }

    const body = (await request.json().catch(() => null)) as null | RolloutBody;
    const listed: unknown[] | undefined = Array.isArray(body?.boxIds) ? (body.boxIds as unknown[]) : undefined;
    const boxIds = listed?.every((id): id is string => typeof id === "string") ? listed : undefined;

    if (typeof body?.releaseId !== "string" || (body.boxIds !== undefined && boxIds === undefined)) {
        return jsonError(400, "releaseId is required; boxIds, when given, is a list of box ids");
    }

    const { releaseId } = body;

    try {
        const release = await context.runQuery<HostdReleaseView | null>(internal.hostd_releases.get, { releaseId });

        if (release === null) {
            return jsonError(404, "no such hostd release");
        }

        const boxes = await context.runMutation<RolloutBox[]>(internal.boxes.setDesiredRelease, { ...(boxIds === undefined ? {} : { boxIds }), releaseId });
        const canarySize = positiveInteger(body.canarySize);
        const batchSize = positiveInteger(body.batchSize);
        const planned = planHostdRollout({
            ...(batchSize === undefined ? {} : { batchSize }),
            boxes,
            ...(canarySize === undefined ? {} : { canarySize }),
            manifestUrl: manifestUrlOf(origin, releaseId),
            release,
        });
        const executionContext = environment.__executionCtx;
        const waitUntil = planned.batches.length > 0 ? executionContext?.waitUntil?.bind(executionContext) : undefined;
        const started = waitUntil !== undefined;

        if (waitUntil !== undefined) {
            waitUntil(
                runHostdRollout(planned, {
                    dispatch: upgradeDispatch(namespace),
                    withdraw: withdrawDesiredRelease(controlPlaneDatabase(environment.DB as D1DatabaseLike), releaseId),
                }).then(
                    (result) => {
                        // eslint-disable-next-line no-console -- the run outlives the response; Workers Logs is its only record
                        console.log("[hostd-rollout]", releaseId, JSON.stringify(result));

                        return result;
                    },
                    (error: unknown) => {
                        // eslint-disable-next-line no-console -- see above
                        console.error("[hostd-rollout]", releaseId, error);
                    },
                ),
            );
        }

        return Response.json({ batches: planned.batches, deferred: planned.deferred, releaseId, skipped: planned.skipped, started }, { status: 202 });
    } catch (error) {
        return rejected(error, "rollout failed");
    }
};
