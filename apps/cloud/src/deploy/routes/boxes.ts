/**
 * The routes a customer box talks to, and the studio's revoke (plan 458 G11–G13).
 *
 * - `POST /v1/boxes/enrol` — `enrolmentToken`: `hostd enrol` trades a one-time
 *   token for a box id, binding the box's public key to the token's org.
 * - `GET /v1/boxes/connect?box={id}` — `boxKey`: the WebSocket upgrade,
 *   forwarded untouched to the box's `BoxSessionDO`, which authenticates the
 *   socket with a challenge before it accepts anything else.
 * - `POST /v1/boxes/revoke` — `session`: revoke a box, then close its session.
 * - `GET /v1/boxes/releases/:deploymentId` — `boxKey`: a box downloads a stored
 *   release, with a request signed by its key (plan 458 D6).
 */
import { api, internal } from "../../../lunora/_generated/api.js";
import type { EnrolResult } from "../../../lunora/boxes";
import { isEnrolmentTokenShape } from "../../boxes/enrolment";
import type { BoxSessionNamespace } from "../../boxes/session-client";
import { boxSession } from "../../boxes/session-client";
import type { VerifiedBoxRequest } from "../../boxes/signed-request";
import { verifyBoxRequest } from "../../boxes/signed-request";
import { sha256Hex } from "../keys";
import { createReleaseStore } from "../release-store";
import { matchRoutePath } from "../route-path";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

/** What the box routes read off the Worker env, beyond the router's own. */
export type BoxRouteEnvironment = {
    /** The per-box session Durable Object namespace; absent → boxes cannot connect to this control plane. */
    BOX_SESSION?: BoxSessionNamespace;
    /** The apex box hostnames live under (`{alias}.{slug}.{LUNORA_BOX_DOMAIN}`); defaults to `boxes.lunora.app`. */
    LUNORA_BOX_DOMAIN?: string;
};

type BoxRouterEnv = BoxRouteEnvironment & RouterEnv;

/** The apex box hostnames live under. */
export const boxDomainOf = (environment: BoxRouteEnvironment): string => environment.LUNORA_BOX_DOMAIN ?? "boxes.lunora.app";

const BOX_ID_PATTERN = /^[\w-]{1,128}$/u;

interface EnrolBody {
    ipv4?: unknown;
    ipv6?: unknown;
    publicKey?: unknown;
    singleTrust?: unknown;
    token?: unknown;
    versions?: { caddy?: unknown; celld?: unknown; hostd?: unknown };
}

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * `POST /v1/boxes/enrol` — consume a one-time enrolment token (plan 458 D4).
 *
 * The token is the whole credential, so it is checked for shape here and
 * hashed at the edge: its plaintext never reaches the store or a log. The
 * mutation refuses expired, unknown and replayed tokens alike, and answers a
 * retry with the same key with the box it already created.
 */
export const handleBoxEnrolRoute = async (request: Request, environment: BoxRouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as EnrolBody | null;

    if (!body || !isEnrolmentTokenShape(body.token)) {
        return jsonError(403, "invalid or expired enrolment token");
    }

    const { versions } = body;

    if (typeof body.publicKey !== "string" || typeof versions?.caddy !== "string" || typeof versions.celld !== "string" || typeof versions.hostd !== "string") {
        return jsonError(400, "publicKey and versions {hostd, celld, caddy} are required");
    }

    const ipv4 = optionalString(body.ipv4);
    const ipv6 = optionalString(body.ipv6);

    try {
        const result = await context.runMutation<EnrolResult>(internal.boxes.enrol, {
            hashedToken: await sha256Hex(body.token),
            ...(ipv4 === undefined ? {} : { ipv4 }),
            ...(ipv6 === undefined ? {} : { ipv6 }),
            publicKey: body.publicKey,
            singleTrust: body.singleTrust === true,
            versions: { caddy: versions.caddy, celld: versions.celld, hostd: versions.hostd },
        });

        return Response.json({
            boxId: result.boxId,
            hostname: `${result.slug}.${boxDomainOf(environment)}`,
            organizationId: result.organizationId,
            slug: result.slug,
        });
    } catch (error) {
        return rejected(error, "enrolment refused");
    }
};

/**
 * `GET /v1/boxes/connect?box={id}` — the box's session upgrade, handed to its
 * `BoxSessionDO` (`idFromName(boxId)`). Nothing is checked here beyond the
 * shape: the object refuses the socket unless it answers the challenge with
 * the box's key, and an unknown id is refused exactly like a wrong signature.
 */
export const handleBoxConnectRoute = (request: Request, environment: BoxRouterEnv): Promise<Response> => {
    const boxId = new URL(request.url).searchParams.get("box") ?? "";

    if (!BOX_ID_PATTERN.test(boxId)) {
        return Promise.resolve(jsonError(400, "box must be a box id"));
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Promise.resolve(jsonError(426, "expected a WebSocket upgrade"));
    }

    const namespace = environment.BOX_SESSION;

    if (!namespace) {
        return Promise.resolve(jsonError(503, "this control plane does not accept boxes"));
    }

    const stub = namespace.get(namespace.idFromName(boxId) as never);

    // Only the upgrade crosses: the object's other paths are the control plane's own.
    return stub.fetch(new Request(`https://box-session.internal/connect?box=${encodeURIComponent(boxId)}`, request));
};

interface RevokeBody {
    id?: string;
    organizationId?: string;
}

/**
 * `POST /v1/boxes/revoke` — revoke a box under the caller's session (the
 * mutation asserts owner/admin and the org), then close its session with
 * `BOX_REVOKED`. Closing is best-effort: a box that is offline is cut off the
 * moment it reconnects, and a live one within a liveness tick regardless.
 */
export const handleBoxRevokeRoute = async (request: Request, environment: BoxRouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as null | RevokeBody;

    if (!body?.id || !body.organizationId) {
        return jsonError(400, "id and organizationId are required");
    }

    try {
        await context.runMutation<{ ipv4?: string; ipv6?: string; slug: string }>(api.boxes.revoke, { id: body.id, organizationId: body.organizationId });
    } catch (error) {
        return rejected(error, "revoke failed");
    }

    const closed = environment.BOX_SESSION
        ? await boxSession(environment.BOX_SESSION, body.id)
              .close("BOX_REVOKED", "this box has been revoked; enrol the machine again to use it")
              .then(
                  () => true,
                  () => false,
              )
        : false;

    return Response.json({ ok: true, sessionClosed: closed });
};

/**
 * Verify a box-signed request against the box's enrolled key, with its nonce
 * claimed in the box's own session object. `null` for anything that does not
 * verify — the caller answers one 401 for all of it.
 */
export const verifiedBoxRequest = async (request: Request, environment: BoxRouterEnv): Promise<null | VerifiedBoxRequest> => {
    const context = requireContext(environment);
    const namespace = environment.BOX_SESSION;

    if (!namespace) {
        return null;
    }

    return verifyBoxRequest(request, {
        claimNonce: (boxId, nonce, expiresAt) => boxSession(namespace, boxId).claimNonce(nonce, expiresAt),
        loadBox: async (boxId) => {
            // A malformed id fails the query's own validator: the same unknown box.
            const box = await context
                .runQuery<null | { organizationId: string; publicKey: string; revoked: boolean }>(internal.boxes.identity, { boxId })
                .catch(() => null);

            return box === null ? null : { organizationId: box.organizationId, publicKey: box.publicKey, revoked: box.revoked };
        },
        now: Date.now(),
    });
};

/** The release-download path; `:deploymentId` is a deployment's id. */
export const BOX_RELEASE_PATH = "/v1/boxes/releases/:deploymentId";

/**
 * `GET /v1/boxes/releases/:deploymentId` — a box fetches the stored release it
 * was told to run (plan 458 D6): the same `{bundle, manifest, assets}` JSON
 * every target converges from, streamed out of the private `RELEASES` bucket.
 *
 * Signed by the box (`boxKey`), and served only for a `celld-vps` deployment of
 * a project placed on that very box — any other answers 404, so a box cannot
 * probe for, or read, another tenant's code.
 */
export const handleBoxReleaseRoute = async (request: Request, environment: BoxRouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const deploymentId = matchRoutePath(BOX_RELEASE_PATH, new URL(request.url).pathname)?.["deploymentId"];

    if (!environment.RELEASES || !environment.BOX_SESSION) {
        return jsonError(503, "this control plane does not serve box releases");
    }

    const verified = await verifiedBoxRequest(request, environment);

    if (verified === null) {
        return jsonError(401, "invalid box signature");
    }

    const allowed =
        deploymentId !== undefined &&
        (await context.runQuery<boolean>(internal.boxes.ownsDeployment, { boxId: verified.boxId, deploymentId }).catch(() => false));
    const release = allowed ? await createReleaseStore(environment.RELEASES).open(deploymentId) : null;

    if (release === null) {
        return jsonError(404, "no such release for this box");
    }

    return new Response(release, { headers: { "cache-control": "no-store", "content-type": "application/json" }, status: 200 });
};
