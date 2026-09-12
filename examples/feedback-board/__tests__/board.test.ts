/**
 * Boots the real schema and procedures against the in-memory harness. The focus
 * is the vote ledger, which is the part with an actual invariant: a vote is a
 * row in `votes` *and* a denormalised `upvoteCount` on `feedback`, and the two
 * must never drift.
 *
 * `summaries.generate` is left out on purpose — it calls Workers AI, and a test
 * that stubs the model tests the stub.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, expect, it } from "vitest";

import { addComment, comments, create, list, myVotes, remove, setStatus, toggleVote } from "../lunora/feedback";
import schema from "../lunora/schema";

const NOT_FOUND_RE = /not found/i;

let t: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    t = lunoraTest(schema);
});

afterEach(() => {
    t.close();
});

const post = async (title: string) => t.mutation(create, { authorName: "ada", description: "why", title });

it("creates a post that starts open with no votes and no comments", async () => {
    expect.assertions(4);
    await post("dark mode");

    const [item] = await t.query(list, {});

    expect(item?.title).toBe("dark mode");
    expect(item?.status).toBe("open");
    expect(item?.upvoteCount).toBe(0);
    expect(item?.commentCount).toBe(0);
});

it("toggles a voter's upvote on and off, keeping the counter in step with the ledger", async () => {
    expect.assertions(6);
    const id = await post("dark mode");
    const voterEmail = "ada@example.com";

    expect(await t.mutation(toggleVote, { feedbackId: id, voterEmail })).toStrictEqual({ voted: true });
    const rows1 = await t.query(list, {});
    expect(rows1[0]?.upvoteCount).toBe(1);
    expect(await t.query(myVotes, { voterEmail })).toStrictEqual([id]);

    expect(await t.mutation(toggleVote, { feedbackId: id, voterEmail })).toStrictEqual({ voted: false });
    const rows2 = await t.query(list, {});
    expect(rows2[0]?.upvoteCount).toBe(0);
    expect(await t.query(myVotes, { voterEmail })).toStrictEqual([]);
});

it("counts a second voter separately", async () => {
    expect.assertions(1);
    const id = await post("dark mode");

    await t.mutation(toggleVote, { feedbackId: id, voterEmail: "ada@example.com" });
    await t.mutation(toggleVote, { feedbackId: id, voterEmail: "grace@example.com" });

    const rows3 = await t.query(list, {});
    expect(rows3[0]?.upvoteCount).toBe(2);
});

it("refuses a vote on a post that is not there", async () => {
    expect.assertions(1);
    const id = await post("dark mode");

    await t.mutation(remove, { id });
    await expect(t.mutation(toggleVote, { feedbackId: id, voterEmail: "ada@example.com" })).rejects.toThrow(NOT_FOUND_RE);
});

it("sorts by votes when the board asks it to", async () => {
    expect.assertions(2);
    const quiet = await post("quiet");
    const loud = await post("loud");

    await t.mutation(toggleVote, { feedbackId: loud, voterEmail: "ada@example.com" });

    const awaited1 = await t.query(list, { sortBy: "votes" });
    expect(awaited1.map((item) => item.title)).toStrictEqual(["loud", "quiet"]);
    expect(quiet).toBeDefined();
});

it("records comments against their post and bumps the count", async () => {
    expect.assertions(2);
    const id = await post("dark mode");

    await t.mutation(addComment, { authorName: "grace", content: "yes please", feedbackId: id });

    const awaited2 = await t.query(comments, { feedbackId: id });
    expect(awaited2.map((comment) => comment.content)).toStrictEqual(["yes please"]);
    const rows4 = await t.query(list, {});
    expect(rows4[0]?.commentCount).toBe(1);
});

it("filters by status once a post is triaged, and deletes cleanly", async () => {
    expect.assertions(3);
    const id = await post("dark mode");

    await t.mutation(setStatus, { id, status: "planned" });

    expect(await t.query(list, { status: "planned" })).toHaveLength(1);
    expect(await t.query(list, { status: "open" })).toStrictEqual([]);

    await t.mutation(remove, { id });
    expect(await t.query(list, {})).toStrictEqual([]);
});
