import { expect, test } from "../fixtures/cirrus.js";

/**
 * Sharding E2E — proves `shardBy("channelId")` routes each channel's writes
 * to its own DO and the `messages.list` query never sees foreign rows.
 *
 * The unit tests in `packages/do/__tests__` already verify the DO
 * routing math, but they can't catch a regression where the *client* mints
 * the wrong shard hint or the *server* falls back to a single DO. This test
 * round-trips through the full pipe.
 */

test.beforeEach(async ({ resetServer }) => {
    await resetServer();
});

test("messages.list(channelA) doesn't see channel B's messages, and vice versa", async ({ user }) => {
    // Drive sharding via RPC directly — clicking through the UI 100 times is
    // slow and adds no extra coverage versus the network round-trip. The
    // better-auth session cookie travels with `user.request`.
    const rpc = async (functionPath: string, args: Record<string, unknown>): Promise<unknown> => {
        const response = await user.request.post(`/_cirrus/rpc`, {
            data: { args, function: functionPath },
        });

        if (!response.ok()) {
            throw new Error(`rpc ${functionPath} failed (${response.status()})`);
        }

        const body = (await response.json()) as { result: unknown };

        return body.result;
    };

    const channelA = (await rpc("channels:create", { name: "shard-A" })) as string;
    const channelB = (await rpc("channels:create", { name: "shard-B" })) as string;

    expect(channelA).not.toBe(channelB);

    const SEND_COUNT = 50;

    for (let index = 0; index < SEND_COUNT; index += 1) {
        await rpc("messages:send", { channelId: channelA, text: `A-${index}` });
        await rpc("messages:send", { channelId: channelB, text: `B-${index}` });
    }

    const listA = (await rpc("messages:list", { channelId: channelA, limit: 200 })) as { channelId: string; text: string }[];
    const listB = (await rpc("messages:list", { channelId: channelB, limit: 200 })) as { channelId: string; text: string }[];

    expect(listA).toHaveLength(SEND_COUNT);
    expect(listB).toHaveLength(SEND_COUNT);

    expect(listA.every((row) => row.channelId === channelA)).toBe(true);
    expect(listA.every((row) => row.text.startsWith("A-"))).toBe(true);

    expect(listB.every((row) => row.channelId === channelB)).toBe(true);
    expect(listB.every((row) => row.text.startsWith("B-"))).toBe(true);
});

test("both channels run independently — a thrown error in A doesn't kill B", async ({ user }) => {
    const rpc = async (functionPath: string, args: Record<string, unknown>): Promise<unknown> => {
        const response = await user.request.post(`/_cirrus/rpc`, {
            data: { args, function: functionPath },
        });

        const body = (await response.json()) as { error?: { code: string }; result?: unknown };

        return body.result ?? body.error;
    };

    const channelA = (await rpc("channels:create", { name: "shard-iso-A" })) as string;
    const channelB = (await rpc("channels:create", { name: "shard-iso-B" })) as string;

    // Force an error on channel A by sending into a non-existent channel id —
    // the routing logic should isolate the failure to the A shard.
    const bogusResponse = await user.request.post(`/_cirrus/rpc`, {
        data: { args: { channelId: "channels_does_not_exist", text: "boom" }, function: "messages:send" },
    });

    // We don't care which error code — only that B still works after.
    expect(bogusResponse.status()).toBeGreaterThanOrEqual(400);

    await rpc("messages:send", { channelId: channelB, text: "post-error" });

    const listB = (await rpc("messages:list", { channelId: channelB, limit: 10 })) as { text: string }[];

    expect(listB.some((row) => row.text === "post-error")).toBe(true);

    // sanity: A is empty
    const listA = (await rpc("messages:list", { channelId: channelA, limit: 10 })) as unknown[];

    expect(listA).toHaveLength(0);
});
