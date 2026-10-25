import { RELAY_SIGNATURE_HEADER, signSiblingBody } from "@lunora/shard-engine";

import { eventLogFrame } from "../../src/event-log-frame";

/** The Worker env every test DO and client is built with: the relay secret is provisioned. */
export const TEST_ENV = { LUNORA_RELAY_SECRET: "s3cret" };

/**
 * A request the EventLogDO accepts: the method, URL and body are signed as one
 * frame, exactly as `EventLogDOClient` signs them.
 */
export const signedRequest = async (method: string, url: string, body = ""): Promise<Request> => {
    const signature = await signSiblingBody(TEST_ENV.LUNORA_RELAY_SECRET, eventLogFrame(method, new URL(url), body));

    if (method === "POST") {
        return new Request(url, { body, headers: { "content-type": "application/json", [RELAY_SIGNATURE_HEADER]: signature }, method });
    }

    return new Request(url, { headers: { [RELAY_SIGNATURE_HEADER]: signature }, method });
};
