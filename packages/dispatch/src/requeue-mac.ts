/**
 * Authentication for the copy a queue consumer re-enqueues when a dispatch is
 * declined on a message's last delivery (see `retryDeclinedMessage`).
 *
 * The copy carries the id of the message it replaces, and the consumer derives
 * its replay-dedup ids from that id. A queue body is app data — often
 * forwarded from outside (a webhook ingest that does `send(await
 * request.json())`) — so a copy the consumer accepted on shape alone would let
 * anyone who can put a body on the queue choose the dedup ids its calls carry:
 * receive another message's cached results, or pre-fill its slots so that
 * message's calls are skipped. A copy is therefore accepted only with a valid
 * HMAC-SHA256 over its claimed id and payload, keyed by the admin token the
 * consumer already holds to dispatch at all. WebCrypto, so it runs on workerd
 * and Node alike.
 */

/** Keeps a MAC made for one purpose from verifying for another. */
const DOMAIN = "lunora.requeue.v1";

const encoder = new TextEncoder();

const importKey = async (secret: string, usage: "sign" | "verify"): Promise<CryptoKey> =>
    crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [usage]);

const message = (scope: string, id: string, payload: string): Uint8Array<ArrayBuffer> => encoder.encode(`${DOMAIN}\n${scope}\n${id}\n${payload}`);

const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const HEX_MAC = /^[\da-f]{64}$/u;

/**
 * The MAC a re-enqueued copy carries: HMAC-SHA256 over `scope`, the replaced
 * message's `id` and the copy's serialised `payload`, keyed by `secret`.
 */
const signRequeue = async (secret: string, scope: string, id: string, payload: string): Promise<string> =>
    toHex(await crypto.subtle.sign("HMAC", await importKey(secret, "sign"), message(scope, id, payload)));

/** `true` only when `mac` is {@link signRequeue}'s MAC for exactly these inputs. The comparison is WebCrypto's, not a string compare. */
const verifyRequeue = async (secret: string, scope: string, id: string, payload: string, mac: unknown): Promise<boolean> => {
    if (typeof mac !== "string" || !HEX_MAC.test(mac)) {
        return false;
    }

    const signature: Uint8Array<ArrayBuffer> = Uint8Array.from({ length: mac.length / 2 }, (_, index) =>
        Number.parseInt(mac.slice(index * 2, index * 2 + 2), 16),
    );

    return crypto.subtle.verify("HMAC", await importKey(secret, "verify"), signature, message(scope, id, payload));
};

export { signRequeue, verifyRequeue };
