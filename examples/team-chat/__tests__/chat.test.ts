/**
 * Boots the real schema and procedures against the in-memory harness. Every
 * procedure here is behind sign-in, so the first thing worth asserting is that
 * a signed-out caller sees and writes nothing.
 *
 * The two attachment actions are left out — they mint R2 signed URLs, and there
 * is no bucket in the harness. Their guard (a key must be prefixed with the
 * caller's own channel/user path) is asserted through `send` instead, which is
 * where a forged key would actually do damage.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, expect, it } from "vitest";

import { create, list as listChannels } from "../lunora/channels";
import { list as listMessages, search, send } from "../lunora/messages";
import { heartbeat, leave, list as listPresence } from "../lunora/presence";
import schema from "../lunora/schema";

let t: ReturnType<typeof lunoraTest>;
let ada: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    t = lunoraTest(schema);
    ada = t.withIdentity({ userId: "u-ada" });
});

afterEach(() => {
    t.close();
});

it("shows a signed-out visitor nothing and lets them write nothing", async () => {
    await ada.mutation(create, { name: "general" });

    expect(await t.query(listChannels, {})).toStrictEqual([]);
    await expect(t.mutation(send, { channelId: "general", content: "hi" })).rejects.toThrow(/sign in/i);
});

it("creates a channel once, slugged, and rejects the duplicate", async () => {
    await ada.mutation(create, { name: "General Chat" });

    expect((await ada.query(listChannels, {})).map((channel) => channel.name)).toStrictEqual(["general-chat"]);
    await expect(ada.mutation(create, { name: "general-chat" })).rejects.toThrow(/already exists/i);
});

it("posts messages into a channel and reads them back", async () => {
    await ada.mutation(create, { name: "general" });
    await ada.mutation(send, { channelId: "general", content: "hello" });
    await t.withIdentity({ userId: "u-grace" }).mutation(send, { channelId: "general", content: "hi back" });

    const messages = await ada.query(listMessages, { channelId: "general" });

    expect(messages.map((message) => message.content)).toStrictEqual(["hello", "hi back"]);
    expect(messages.map((message) => message.authorId)).toStrictEqual(["u-ada", "u-grace"]);
});

it("keeps channels apart", async () => {
    await ada.mutation(send, { channelId: "general", content: "in general" });
    await ada.mutation(send, { channelId: "random", content: "in random" });

    expect((await ada.query(listMessages, { channelId: "random" })).map((message) => message.content)).toStrictEqual(["in random"]);
});

it("refuses an attachment key that belongs to someone else", async () => {
    await expect(ada.mutation(send, { attachmentKey: "general/u-grace/secret.png", channelId: "general", content: "" })).rejects.toThrow();
});

it("searches within a channel and returns nothing for an empty term", async () => {
    await ada.mutation(send, { channelId: "general", content: "deploy is green" });
    await ada.mutation(send, { channelId: "general", content: "lunch?" });

    expect((await ada.query(search, { channelId: "general", text: "deploy" })).map((message) => message.content)).toStrictEqual(["deploy is green"]);
    expect(await ada.query(search, { channelId: "general", text: "   " })).toStrictEqual([]);
});

it("tracks presence per session and clears it on leave", async () => {
    await ada.mutation(heartbeat, { channelId: "general", name: "Ada", sessionId: "s1" });

    expect((await ada.query(listPresence, { channelId: "general" })).map((row) => row.name)).toStrictEqual(["Ada"]);

    // A second heartbeat from the same session must refresh, not duplicate.
    await ada.mutation(heartbeat, { channelId: "general", name: "Ada", sessionId: "s1" });
    expect(await ada.query(listPresence, { channelId: "general" })).toHaveLength(1);

    await ada.mutation(leave, { channelId: "general", sessionId: "s1" });
    expect(await ada.query(listPresence, { channelId: "general" })).toStrictEqual([]);
});
