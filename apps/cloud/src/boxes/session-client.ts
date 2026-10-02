/**
 * The control plane's handle on a box's `BoxSessionDO` (plan 458 G11): the
 * object's native RPC surface, reached over the Durable Object namespace
 * binding, so it never leaves Cloudflare. The public router forwards nothing
 * but the box's own WebSocket upgrade (`fetch`) to the object.
 */
import type { HostdJob } from "@lunora/hostd/protocol";

import type { JobOutcome } from "./jobs";

/** What the control plane calls on a box's session. `BoxSessionDO` implements it; a stub of it answers it over RPC. */
export interface BoxSession {
    /** Forget-proof replay protection: `true` the first time `nonce` is claimed before `expiresAt`, `false` for a replay (or a nonce of the wrong shape). */
    claimNonce: (nonce: string, expiresAt: number) => Promise<boolean>;
    /** Refuse every socket of the box with `code` (revocation), and fail its jobs. Answers how many sockets it closed. */
    close: (code: string, message: string) => Promise<number>;

    /**
     * Run `job` on the box. Resolves — never rejects — with its result once the
     * box answers, the job times out, or the box disconnects; a job the session
     * refuses outright resolves failed with `BOX_OFFLINE` (plan 458 D14),
     * `BOX_BUSY` or `BAD_JOB`. Each `progress` line goes to `onProgress` as it
     * arrives — over RPC, a callback into the caller.
     */
    dispatch: (job: HostdJob, options?: { onProgress?: (line: string) => void; timeoutMs?: number }) => Promise<JobOutcome>;
    /** The box's WebSocket upgrade, forwarded by `GET /v1/boxes/connect` — the one call that crosses from outside. */
    fetch: (request: Request) => Promise<Response>;
    /** Recompute and push the box's routing table; `false` when the box is not connected (it gets it on connect). */
    pushRoutes: () => Promise<boolean>;
}

/** The slice of the `BOX_SESSION` namespace binding the control plane uses. */
export interface BoxSessionNamespace {
    get: (id: DurableObjectId) => BoxSession;
    idFromName: (name: string) => DurableObjectId;
}

/** The session of box `boxId`. */
export const boxSession = (namespace: BoxSessionNamespace, boxId: string): BoxSession => namespace.get(namespace.idFromName(boxId));

/**
 * Cut a revoked box off: close every socket of its session with `BOX_REVOKED`,
 * failing the jobs sent on them. `null` once closed, else why not — no session
 * namespace bound here, or a close that failed. The revoke route and the box
 * sweep both retire boxes through it; either way the session also closes itself
 * within a liveness tick of reading the revoked row.
 */
export const retireBox = async (namespace: BoxSessionNamespace | undefined, boxId: string, message: string): Promise<null | string> => {
    if (namespace === undefined) {
        return "this control plane has no box sessions bound (BOX_SESSION)";
    }

    try {
        await boxSession(namespace, boxId).close("BOX_REVOKED", message);

        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
};
