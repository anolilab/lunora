import { bench, describe } from "vitest";

import { toBase64Url } from "../../../shared/base64";
import { signCanonical } from "../../../shared/hmac-url";

/*
 * Every alarm-fired dispatch HMAC-signs its JSON body with
 * LUNORA_SCHEDULER_SECRET.
 *
 * old — `crypto.subtle.importKey` on every dispatch, then `sign` and the base64url encode.
 * new — `shared/hmac-url`'s `signCanonical`, which memoizes the imported key per secret.
 */

const secret = "s".repeat(32);
const body = JSON.stringify({ args: { orderId: "o_123", total: 42 }, functionPath: "orders:charge", id: "job_abc", scheduledFor: Date.now() });
const encoder = new TextEncoder();

describe("SchedulerDO.signDispatch", () => {
    bench("import key per dispatch (old)", async () => {
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);

        toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))));
    });

    bench("memoized key via signCanonical (new)", async () => {
        await signCanonical(secret, body);
    });
});
