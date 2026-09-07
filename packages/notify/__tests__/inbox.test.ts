import { describe, expect, it } from "vitest";

import { memoryInboxStore } from "../src/inbox/memory-store";

describe("memoryInboxStore (plan 241 spike — read half prototype)", () => {
    it("append 3 -> unreadCount 3", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        await store.append({ payload: { body: "one" }, userId: "u1" });
        await store.append({ payload: { body: "two" }, userId: "u1" });
        await store.append({ payload: { body: "three" }, userId: "u1" });

        await expect(store.unreadCount("u1")).resolves.toBe(3);
    });

    it("markRead(one) -> unreadCount 2", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        const first = await store.append({ payload: { body: "one" }, userId: "u1" });

        await store.append({ payload: { body: "two" }, userId: "u1" });
        await store.append({ payload: { body: "three" }, userId: "u1" });

        await store.markRead("u1", first.id);

        await expect(store.unreadCount("u1")).resolves.toBe(2);

        const [readItem] = await store.list("u1", { limit: 1, unreadOnly: false });

        expect(readItem?.id).not.toBe(first.id); // newest-first: the just-appended "three" leads, not "one"
    });

    it("markRead is idempotent (marking an already-read item again is a no-op)", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();
        const item = await store.append({ payload: { body: "one" }, userId: "u1" });

        await store.markRead("u1", item.id);

        const [afterFirst] = await store.list("u1");
        const firstReadAt = afterFirst?.readAt;

        await store.markRead("u1", item.id);

        const [afterSecond] = await store.list("u1");

        expect(afterSecond?.readAt).toBe(firstReadAt);
        await expect(store.unreadCount("u1")).resolves.toBe(0);
    });

    it("markRead cannot mark another user's item", async () => {
        expect.hasAssertions();

        // Every sibling operation is `userId`-scoped; an unscoped `markRead(id)`
        // lets any caller holding (or guessing) an id clear someone else's
        // notification — the id is the whole authorisation.
        const store = memoryInboxStore();
        const theirs = await store.append({ payload: { body: "theirs" }, userId: "u2" });

        await store.markRead("u1", theirs.id);

        await expect(store.unreadCount("u2")).resolves.toBe(1);
    });

    it("markRead on an unknown id is a safe no-op", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        await expect(store.markRead("u1", "inbox_does_not_exist")).resolves.toBeUndefined();
    });

    it("listInbox returns newest-first", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        const first = await store.append({ payload: { body: "first" }, userId: "u1" });
        const second = await store.append({ payload: { body: "second" }, userId: "u1" });
        const third = await store.append({ payload: { body: "third" }, userId: "u1" });

        const listed = await store.list("u1");

        expect(listed.map((item) => item.id)).toStrictEqual([third.id, second.id, first.id]);
    });

    it("listInbox pages with an exclusive `after` cursor, newest-first, no skip/duplicate", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();
        const appended: string[] = [];

        for (let index = 0; index < 7; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential append in a test
            const item = await store.append({ payload: { body: `item-${index.toString()}` }, userId: "u1" });

            appended.push(item.id);
        }

        // Newest-first order is the reverse of append order.
        const expectedOrder = appended.toReversed();

        const seen: string[] = [];
        let cursor: string | undefined;

        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential in this walk
            const page = await store.list("u1", { after: cursor, limit: 3 });

            if (page.length === 0) {
                break;
            }

            seen.push(...page.map((item) => item.id));
            cursor = page[page.length - 1]?.id;

            if (page.length < 3) {
                break;
            }
        }

        expect(seen).toStrictEqual(expectedOrder);
    });

    it("unreadOnly filters out read items", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();
        const first = await store.append({ payload: { body: "one" }, userId: "u1" });

        await store.append({ payload: { body: "two" }, userId: "u1" });
        await store.markRead("u1", first.id);

        const unread = await store.list("u1", { unreadOnly: true });

        expect(unread).toHaveLength(1);
        expect(unread[0]?.id).not.toBe(first.id);
    });

    it("markAllRead -> unreadCount 0, and returns the count changed", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        await store.append({ payload: { body: "one" }, userId: "u1" });
        await store.append({ payload: { body: "two" }, userId: "u1" });
        await store.append({ payload: { body: "three" }, userId: "u1" });

        const changed = await store.markAllRead("u1");

        expect(changed).toBe(3);
        await expect(store.unreadCount("u1")).resolves.toBe(0);

        // Idempotent: nothing left to change on a second call.
        await expect(store.markAllRead("u1")).resolves.toBe(0);
    });

    it("isolates items per user — one user's append/read never touches another's", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        await store.append({ payload: { body: "for u1" }, userId: "u1" });
        await store.append({ payload: { body: "for u2 (a)" }, userId: "u2" });
        await store.append({ payload: { body: "for u2 (b)" }, userId: "u2" });

        await expect(store.unreadCount("u1")).resolves.toBe(1);
        await expect(store.unreadCount("u2")).resolves.toBe(2);

        const changed = await store.markAllRead("u1");

        expect(changed).toBe(1);
        await expect(store.unreadCount("u2")).resolves.toBe(2);

        const u1Items = await store.list("u1");
        const u2Items = await store.list("u2");

        expect(u1Items).toHaveLength(1);
        expect(u2Items).toHaveLength(2);
    });

    it("round-trips payload, category and groupKey", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();
        const stored = await store.append({
            category: "billing",
            groupKey: "invoice:42",
            payload: { body: "Your invoice is ready", title: "Invoice #42" },
            userId: "u1",
        });

        expect(stored).toMatchObject({
            category: "billing",
            groupKey: "invoice:42",
            payload: { body: "Your invoice is ready", title: "Invoice #42" },
            userId: "u1",
        });
        expect(stored.readAt).toBeUndefined();
        expect(typeof stored.createdAt).toBe("number");

        const [listed] = await store.list("u1");

        expect(listed).toStrictEqual(stored);
    });

    it("respects `limit` without a cursor", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        for (let index = 0; index < 5; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential append in a test
            await store.append({ payload: { body: `item-${index.toString()}` }, userId: "u1" });
        }

        const page = await store.list("u1", { limit: 2 });

        expect(page).toHaveLength(2);
    });

    it("an empty inbox lists empty and reports zero unread", async () => {
        expect.hasAssertions();

        const store = memoryInboxStore();

        await expect(store.list("nobody")).resolves.toStrictEqual([]);
        await expect(store.unreadCount("nobody")).resolves.toBe(0);
        await expect(store.markAllRead("nobody")).resolves.toBe(0);
    });
});
