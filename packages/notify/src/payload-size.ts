import { LunoraError } from "@lunora/errors";
import type { PushPayload } from "@visulima/notification";

/**
 * FCM HTTP v1 rejects a payload over 4096 bytes. The guard uses the same limit for Web
 * Push, whose floor is also 4096 bytes but measured over the encrypted body, so the check
 * is approximate there too: a payload just under the limit can still be rejected upstream.
 */
const PUSH_PAYLOAD_LIMIT_BYTES = 4096;

const stringifyValue = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * Reject an oversize push before any transport is contacted.
 *
 * The size is measured over the fields the transport serialises (`data` with non-string
 * values JSON-encoded, `title`, `body`, `imageUrl`), plus the per-platform `fcmOverrides` when
 * `fcm` is set, so it tracks what would be sent to each transport it reaches.
 * The device token and the fixed envelope are not counted. The check exists to fail the
 * caller's own oversize message clearly and cheaply, not to replace the provider's answer.
 *
 * `PAYLOAD_TOO_LARGE` is thrown, not reported per device, so callers see one rejection
 * instead of a failed row for every recipient.
 */
const assertPushPayloadFits = (payload: Omit<PushPayload, "to"> & { fcmOverrides?: unknown }, { fcm = false }: { fcm?: boolean } = {}): void => {
    const data = payload.data === undefined ? undefined : Object.fromEntries(Object.entries(payload.data).map(([key, value]) => [key, stringifyValue(value)]));

    // `fcmOverrides` only reaches FCM. A send that targets Web Push alone is not measured against
    // FCM's per-platform fields, so an FCM-only block cannot reject a Web Push send.
    // `clickAction`, `sound` and `badge` are written into the FCM message's platform blocks, so they count for an FCM target only.
    const fcmOnly = fcm ? { badge: payload.badge, clickAction: payload.clickAction, fcmOverrides: payload.fcmOverrides, sound: payload.sound } : {};

    const size = new TextEncoder().encode(JSON.stringify({ body: payload.body, data, image: payload.imageUrl, title: payload.title, ...fcmOnly })).length;

    if (size > PUSH_PAYLOAD_LIMIT_BYTES) {
        throw new LunoraError(
            "PAYLOAD_TOO_LARGE",
            `@lunora/notify: push payload is ${String(size)} bytes; FCM and Web Push accept at most ${String(PUSH_PAYLOAD_LIMIT_BYTES)} bytes`,
        );
    }
};

export { assertPushPayloadFits, PUSH_PAYLOAD_LIMIT_BYTES };
