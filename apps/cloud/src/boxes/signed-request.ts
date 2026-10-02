/**
 * Box-signed HTTP requests (plan 458 D6, G14; `protocol/hostd/README.md` §6.2):
 * how a box authenticates a plain HTTPS request — a release download, a
 * release manifest — with the same key its session uses.
 *
 * The box sends four headers ({@link HOSTD_REQUEST_HEADERS}); the server
 * rebuilds the signed payload from the request IT received (method, path and
 * query), so a signature cannot be moved to another path. Replay protection is
 * the box-chosen single-use nonce, remembered in the box's own session object:
 *
 * - with a timestamp, the request must be within {@link TIMESTAMP_WINDOW_MS} of
 *   the control plane's clock, and its nonce is remembered until the window
 *   closes — after that the timestamp alone refuses it;
 * - without one (README: a skewed clock must not lock a box out), the nonce is
 *   remembered for {@link UNTIMED_NONCE_TTL_MS}.
 *
 * Every refusal answers the same 401, so a caller learns nothing about which
 * box ids exist or which check failed.
 */
import { HOSTD_REQUEST_HEADERS, requestSigningPayload } from "@lunora/hostd/protocol";

import { verifyBoxSignature } from "./encoding";

/** How far a signed request's timestamp may sit from the control plane's clock. */
export const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/** How long the nonce of a request without a timestamp is remembered. */
export const UNTIMED_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

const BOX_ID_PATTERN = /^[\w-]{1,128}$/u;

const NONCE_PATTERN = /^[\w-]{22,128}$/u;

const TIMESTAMP_PATTERN = /^\d{1,16}$/u;

/** A box as a signed request is checked against. */
export interface SigningBox {
    organizationId: string;
    publicKey: string;
    revoked: boolean;
}

export interface SignedRequestPorts {
    /** Claim `nonce` for `boxId` until `expiresAt`; `false` when it was already claimed (a replay). */
    claimNonce: (boxId: string, nonce: string, expiresAt: number) => Promise<boolean>;
    loadBox: (boxId: string) => Promise<null | SigningBox>;
    now: number;
}

/** A verified signed request: which box sent it. */
export interface VerifiedBoxRequest {
    boxId: string;
    organizationId: string;
}

/**
 * Verify a box-signed request, or answer why not (`null`). Checks the shape,
 * the timestamp window, the box (known, not revoked), the signature, and only
 * then claims the nonce — so a forged request cannot burn a real one.
 */
export const verifyBoxRequest = async (request: Request, ports: SignedRequestPorts): Promise<null | VerifiedBoxRequest> => {
    const boxId = request.headers.get(HOSTD_REQUEST_HEADERS.boxId) ?? "";
    const nonce = request.headers.get(HOSTD_REQUEST_HEADERS.nonce) ?? "";
    const signature = request.headers.get(HOSTD_REQUEST_HEADERS.signature) ?? "";
    const stamp = request.headers.get(HOSTD_REQUEST_HEADERS.timestamp);

    if (!BOX_ID_PATTERN.test(boxId) || !NONCE_PATTERN.test(nonce) || (stamp !== null && !TIMESTAMP_PATTERN.test(stamp))) {
        return null;
    }

    const timestamp = stamp === null ? undefined : Number(stamp);

    if (timestamp !== undefined && Math.abs(ports.now - timestamp) > TIMESTAMP_WINDOW_MS) {
        return null;
    }

    const url = new URL(request.url);
    let payload: Uint8Array;

    try {
        payload = requestSigningPayload({
            boxId,
            method: request.method,
            nonce,
            path: `${url.pathname}${url.search}`,
            ...(timestamp === undefined ? {} : { timestamp }),
        });
    } catch {
        return null;
    }

    const box = await ports.loadBox(boxId);

    if (box === null || box.revoked || !(await verifyBoxSignature(box.publicKey, signature, payload))) {
        return null;
    }

    const expiresAt = timestamp === undefined ? ports.now + UNTIMED_NONCE_TTL_MS : timestamp + TIMESTAMP_WINDOW_MS;

    return (await ports.claimNonce(boxId, nonce, expiresAt)) ? { boxId, organizationId: box.organizationId } : null;
};
