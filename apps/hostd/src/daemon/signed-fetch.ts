/**
 * Box-signed HTTP requests to the control plane (plan 458 D6, protocol §6.2):
 * how the box fetches a stored release or a `lunora-hostd` release manifest.
 *
 * Every request carries the box id, a fresh nonce, the current time and an
 * Ed25519 signature over the protocol's request payload — the timestamp is mandatory,
 * so a captured request goes stale in five minutes. A URL whose origin is not
 * the control plane the box enrolled with is refused before anything is
 * signed: otherwise a job could make the box sign requests for a third party.
 * Redirects are refused for the same reason.
 */
import { randomBytes } from "node:crypto";

import { HOSTD_REQUEST_HEADERS, requestSigningPayload } from "../wire/signing";
import type { BoxIdentity } from "./identity";
import { JobError } from "./job-error";

interface SignedFetchOptions {
    boxId: string;
    /** The enrolled control plane's origin; the only one requests are signed for. */
    controlPlane: string;
    /** Injected for tests. */
    fetch?: typeof fetch;
    identity: BoxIdentity;
    /** A fresh request nonce (≥ 22 base64url characters); injected for tests. */
    nonce?: () => string;
    /** The clock, in epoch ms; injected for tests. */
    now?: () => number;
}

/** A signed `GET` of `url` on the control plane. */
type SignedFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const createSignedFetch = (options: SignedFetchOptions): SignedFetch => {
    const fetcher = options.fetch ?? globalThis.fetch;
    const nonce = options.nonce ?? (() => randomBytes(24).toString("base64url"));
    const now = options.now ?? Date.now;
    const { origin } = new URL(options.controlPlane);

    return async (url, init = {}) => {
        let target: URL;

        try {
            target = new URL(url);
        } catch {
            throw new JobError("ORIGIN_REFUSED", "the control plane named a URL that does not parse");
        }

        if (target.origin !== origin || target.username !== "" || target.password !== "") {
            throw new JobError("ORIGIN_REFUSED", `refusing to sign a request for ${target.origin}: this box only talks to ${origin}`);
        }

        const timestamp = now();
        const requestNonce = nonce();
        const path = `${target.pathname}${target.search}`;
        const signature = options.identity.sign(requestSigningPayload({ boxId: options.boxId, method: "GET", nonce: requestNonce, path, timestamp }));

        return fetcher(target, {
            headers: {
                [HOSTD_REQUEST_HEADERS.boxId]: options.boxId,
                [HOSTD_REQUEST_HEADERS.nonce]: requestNonce,
                [HOSTD_REQUEST_HEADERS.signature]: signature,
                [HOSTD_REQUEST_HEADERS.timestamp]: String(timestamp),
            },
            method: "GET",
            redirect: "error",
            ...(init.signal === undefined ? {} : { signal: init.signal }),
        });
    };
};

export type { SignedFetch, SignedFetchOptions };
export { createSignedFetch };
