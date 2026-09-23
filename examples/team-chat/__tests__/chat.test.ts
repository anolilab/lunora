/**
 * Boots the real schema and procedures against the in-memory harness. Every
 * procedure here is behind sign-in, so the first thing worth asserting is that
 * a signed-out caller sees and writes nothing.
 *
 * The harness has no R2 bucket: `ctx.storage` throws the moment a handler
 * touches it, and each signing action wraps that in its own "object storage did
 * not answer". That makes it a usable oracle — a call refused BEFORE that error
 * proves the guard ran first, and one that reaches it proves the handler got as
 * far as signing a key it resolved server-side. Harness v1 also creates only
 * the sharded tables, so the `.global()` `profiles` row cannot be read here;
 * `avatarUrl` is pinned at its argument boundary instead.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { Id } from "../lunora/_generated/dataModel";
import { create, list as listChannels } from "../lunora/channels";
import { attachmentUrl, list as listMessages, search, send } from "../lunora/messages";
import { heartbeat, leave, list as listPresence } from "../lunora/presence";
import { avatarUrl, save } from "../lunora/profiles";
import schema from "../lunora/schema";

const SIGN_IN_RE = /sign in/i;
const ALREADY_EXISTS_RE = /already exists/i;
const NO_ATTACHMENT_RE = /no attachment/i;
const NOT_YOUR_KEY_RE = /not your avatar key/i;
const SIGNING_FAILED_RE = /object storage did not answer/i;

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
    expect.assertions(2);
    await ada.mutation(create, { name: "general" });

    expect(await t.query(listChannels, {})).toStrictEqual([]);
    await expect(t.mutation(send, { channelId: "general", content: "hi" })).rejects.toThrow(SIGN_IN_RE);
});

it("creates a channel once, slugged, and rejects the duplicate", async () => {
    expect.assertions(2);
    await ada.mutation(create, { name: "General Chat" });

    const awaited1 = await ada.query(listChannels, {});
    expect(awaited1.map((channel) => channel.name)).toStrictEqual(["general-chat"]);
    await expect(ada.mutation(create, { name: "general-chat" })).rejects.toThrow(ALREADY_EXISTS_RE);
});

it("posts messages into a channel and reads them back", async () => {
    expect.assertions(1);
    await ada.mutation(create, { name: "general" });
    await ada.mutation(send, { channelId: "general", content: "hello" });
    await t.withIdentity({ userId: "u-grace" }).mutation(send, { channelId: "general", content: "hi back" });

    const messages = await ada.query(listMessages, { channelId: "general" });

    // Asserted as a set, not a sequence. `messages` is not `.commitOrdered()`,
    // and `list` reads it `.withIndex("by_channel").order("asc")` — so rows
    // sharing a channel are ordered by `_creationTime`, which has millisecond
    // resolution. Two sends inside one tick have no discriminator left, and the
    // relative order of these two is genuinely undefined.
    //
    // It used to look stable only because the index could not satisfy the
    // ORDER BY and SQLite sorted into a temp B-tree that happened to preserve
    // insertion order. Indexing the sort keys made that an index walk, and the
    // accident went away.
    //
    // `_creationTime` is deliberately NOT the fix: it records when a row was
    // MADE, and the docs are explicit that stamp order and commit order can
    // disagree. A table that needs write order declares `.commitOrdered()` and
    // reads `orderBy: [{ _commitSeq: "asc" }]`; two chat messages a millisecond
    // apart do not need it.
    // Compared as a set, with no comparator: `localeCompare` would make this
    // assertion depend on the runner's ICU build, which is exactly the locale
    // sensitivity the shared key encoder documents avoiding.
    expect(new Set(messages.map((message) => `${message.authorId}:${message.content}`))).toStrictEqual(new Set(["u-ada:hello", "u-grace:hi back"]));
});

it("keeps channels apart", async () => {
    expect.assertions(1);
    await ada.mutation(send, { channelId: "general", content: "in general" });
    await ada.mutation(send, { channelId: "random", content: "in random" });

    const awaited2 = await ada.query(listMessages, { channelId: "random" });
    expect(awaited2.map((message) => message.content)).toStrictEqual(["in random"]);
});

it("refuses an attachment key that belongs to someone else", async () => {
    expect.assertions(1);
    await expect(ada.mutation(send, { attachmentKey: "general/u-grace/secret.png", channelId: "general", content: "" })).rejects.toThrow();
});

it("searches within a channel and returns nothing for an empty term", async () => {
    expect.assertions(2);
    await ada.mutation(send, { channelId: "general", content: "deploy is green" });
    await ada.mutation(send, { channelId: "general", content: "lunch?" });

    const awaited3 = await ada.query(search, { channelId: "general", text: "deploy" });
    expect(awaited3.map((message) => message.content)).toStrictEqual(["deploy is green"]);
    expect(await ada.query(search, { channelId: "general", text: "   " })).toStrictEqual([]);
});

it("tracks presence per session and clears it on leave", async () => {
    expect.assertions(3);
    await ada.mutation(heartbeat, { channelId: "general", name: "Ada", sessionId: "s1" });

    const awaited4 = await ada.query(listPresence, { channelId: "general" });
    expect(awaited4.map((row) => row.name)).toStrictEqual(["Ada"]);

    // A second heartbeat from the same session must refresh, not duplicate.
    await ada.mutation(heartbeat, { channelId: "general", name: "Ada", sessionId: "s1" });
    expect(await ada.query(listPresence, { channelId: "general" })).toHaveLength(1);

    await ada.mutation(leave, { channelId: "general", sessionId: "s1" });
    expect(await ada.query(listPresence, { channelId: "general" })).toStrictEqual([]);
});

it("will not sign a download for a message that carries no attachment", async () => {
    expect.assertions(1);
    const messageId = await ada.mutation(send, { channelId: "general", content: "no file here" });

    // Refused at the row, before `ctx.storage` is touched at all. The old shape
    // took the object key from `args` and checked it against a prefix built out
    // of another `args` field, so this call had nothing to fail on — every
    // `files/channels/…` string in the bucket was signable by anyone.
    await expect(ada.action(attachmentUrl, { messageId })).rejects.toThrow(NO_ATTACHMENT_RE);
});

it("will not sign a download for a message id that does not exist", async () => {
    expect.assertions(1);

    await expect(ada.action(attachmentUrl, { messageId: "m-does-not-exist" as Id<"messages"> })).rejects.toThrow(NO_ATTACHMENT_RE);
});

it("signs only the key stored on the message, reached through the row", async () => {
    expect.assertions(1);
    const messageId = await ada.mutation(send, {
        attachmentKey: "files/channels/general/u-ada/f.png",
        channelId: "general",
        content: "",
    });

    // Past the guard and into the bucket, which the harness does not provide —
    // the handler's own `catch` reports the stub as a signing failure. The point
    // is what it took to get here: a message id, resolved server-side. There is
    // no argument on this action that names an object.
    await expect(ada.action(attachmentUrl, { messageId })).rejects.toThrow(SIGNING_FAILED_RE);
});

it("refuses a profile save that claims an avatar key that is not the caller's own", async () => {
    expect.assertions(2);

    // `avatarKey` is stored and later treated as an object reference, so a
    // caller-written value here is the same hole as accepting a key at the
    // signing action — just laundered through the row.
    await expect(ada.mutation(save, { avatarKey: "files/avatars/u-grace", name: "Ada" })).rejects.toThrow(NOT_YOUR_KEY_RE);
    await expect(ada.mutation(save, { avatarKey: "files/channels/general/u-grace/f.png", name: "Ada" })).rejects.toThrow(NOT_YOUR_KEY_RE);
});

it("gives the avatar action no argument that names an object", async () => {
    expect.assertions(2);

    // The old shape took `{ key }` and let anything under `files/avatars/`
    // through. Validation runs before the handler, so these are refused without
    // the bucket — or the `.global()` profiles table, which harness v1 does not
    // create — being reachable at all.
    await expect(ada.action(avatarUrl, { key: "files/avatars/u-grace" } as unknown as { userId: string })).rejects.toThrow();
    await expect(ada.action(avatarUrl, {} as unknown as { userId: string })).rejects.toThrow();
});
