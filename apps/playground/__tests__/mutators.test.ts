/**
 * `lunora/mutators.ts` is publicly dispatchable — codegen registers
 * `mutators:sendMessage` in `LUNORA_FUNCTIONS` and exposes it on the `api`
 * proxy — so it carries the same author-identity and input-size guarantees as
 * its sibling `messages.send`. These tests drive the registered mutator's
 * `handler` (the exact entry point the shard DO's push path calls) rather than
 * reading the source, so a regression has to be a behaviour change.
 *
 * The three cases below all reject BEFORE the authoritative `server` impl runs
 * (`validateArgs` → `applyOwnerScope` → `server`), which is why no `ctx.db` is
 * needed: a fake identity-only context is the whole trusted surface they read.
 */
import { describe, expect, it } from "vitest";

import { sendMessage } from "../lunora/mutators";

/**
 * The trusted server context shape `defineMutator`'s owner scoping reads.
 *
 * Deliberately partial: every case here rejects before the authoritative
 * `server` impl runs, so `auth` is the whole surface they touch. Typed off the
 * handler's own parameter so a change to that signature surfaces here.
 */
const contextFor = (userId: string | undefined): Parameters<typeof sendMessage.handler>[0] =>
    ({ auth: { userId } }) as Parameters<typeof sendMessage.handler>[0];

const validArgs = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        channelId: "c1",
        createdAt: 1_700_000_000_000,
        text: "hello",
        userId: "u1",
        ...overrides,
    };
};

describe("mutators:sendMessage", () => {
    it("is owner-scoped so the author cannot be taken from the wire", () => {
        expect.assertions(1);

        // The declaration itself is the control: `owner` makes the runtime
        // require an identity and overwrite the column with the verified value.
        expect(sendMessage.owner).toBe("userId");
    });

    it("rejects a userId that disagrees with the verified identity", async () => {
        expect.assertions(1);

        // The spoof: signed in as u1, claiming to post as u2. Without owner
        // scoping this wrote u2 verbatim and rendered under u2's name.
        await expect(sendMessage.handler(contextFor("u1"), validArgs({ userId: "u2" }))).rejects.toThrow(/does not match the verified identity/u);
    });

    it("rejects an unauthenticated caller outright", async () => {
        expect.assertions(1);

        await expect(sendMessage.handler(contextFor(undefined), validArgs())).rejects.toThrow(/requires a verified identity/u);
    });

    it("rejects text over the 4096-character cap", async () => {
        expect.assertions(1);

        // `v.string()` alone is unbounded — the cap has to be declared, and it
        // must match `messages.send`'s so neither entry point is the soft one.
        await expect(sendMessage.handler(contextFor("u1"), validArgs({ text: "x".repeat(4097) }))).rejects.toThrow(/4096/u);
    });

    it("accepts text at exactly the cap", async () => {
        expect.assertions(1);

        // Rejects later (no `ctx.db` for the rate limiter), but NOT for length —
        // pins the boundary as inclusive so the cap can't drift to 4095.
        await expect(sendMessage.handler(contextFor("u1"), validArgs({ text: "x".repeat(4096) }))).rejects.not.toThrow(/4096 characters/u);
    });
});
