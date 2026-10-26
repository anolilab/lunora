import { RELAY_SIGNATURE_HEADER, signSiblingBody } from "../../../../shared/relay-signature";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { EventLogDOClient } from "../../src/event-log-do-client";
import { eventLogFrame } from "../../src/event-log-frame";

/** One log per test, addressed by its own DO id, so no test reads another's appends. */
const logNamed = (name: string) => {
    const id = env.EVENT_LOG_DO.idFromName(name);
    const stub = env.EVENT_LOG_DO.get(id);
    const client = new EventLogDOClient({ env, fetch: (request) => stub.fetch(request), instance: id.toString() });

    return { client, id, stub };
};

describe("eventLogDO in workerd", () => {
    it("persists a signed append and reads it back", async () => {
        expect.assertions(2);

        const { client } = logNamed("persist");

        const entries = await client.append([{ type: "chat.sent", payload: { text: "hi" } }], { batchId: "batch-persist" });
        const { entries: since } = await client.getSince(0);

        expect(entries).toHaveLength(1);
        expect(since).toMatchObject([{ payload: { text: "hi" }, type: "chat.sent" }]);
    });

    it("answers a replayed batchId with the original entries, without a second write", async () => {
        expect.assertions(2);

        const { client } = logNamed("replay");
        const events = [{ type: "counter.bumped", payload: { n: 1 } }];

        const first = await client.append(events, { batchId: "replay-key" });
        const second = await client.append(events, { batchId: "replay-key" });

        expect(second).toStrictEqual(first);
        await expect(client.getSize()).resolves.toBe(1);
    });

    it("refuses an unsigned request before it reads the log", async () => {
        expect.assertions(1);

        const { stub } = logNamed("unsigned");
        const response = await stub.fetch("https://do/size");

        expect(response.status).toBe(403);
    });

    it("refuses a request signed for another instance", async () => {
        expect.assertions(1);

        const { stub } = logNamed("instance-check");
        const other = env.EVENT_LOG_DO.idFromName("other-log");
        const url = new URL("https://do/size");
        const signature = await signSiblingBody(env.LUNORA_RELAY_SECRET, eventLogFrame(other.toString(), "GET", url, ""));

        const response = await stub.fetch(new Request(url, { headers: { [RELAY_SIGNATURE_HEADER]: signature } }));

        expect(response.status).toBe(403);
    });
});
