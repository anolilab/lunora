import { RELAY_SIGNATURE_HEADER, signSiblingBody } from "../../../../shared/relay-signature";
import { eventLogFrame } from "../../src/event-log-frame";

/** The Worker env every test DO and client is built with: the relay secret is provisioned. */
export const TEST_ENV = { LUNORA_RELAY_SECRET: "s3cret" };

/** The instance id a test DO is created with, and the one a test client addresses. */
export const TEST_INSTANCE = "test-instance";

/**
 * A request the EventLogDO accepts: the instance, method, URL and body are signed as one
 * frame, exactly as `EventLogDOClient` signs them for the instance it addresses.
 */
export const signedRequest = async (method: string, url: string, body = "", instance = TEST_INSTANCE): Promise<Request> => {
    const signature = await signSiblingBody(TEST_ENV.LUNORA_RELAY_SECRET, eventLogFrame(instance, method, new URL(url), body));

    if (method === "POST") {
        return new Request(url, { body, headers: { "content-type": "application/json", [RELAY_SIGNATURE_HEADER]: signature }, method });
    }

    return new Request(url, { headers: { [RELAY_SIGNATURE_HEADER]: signature }, method });
};
