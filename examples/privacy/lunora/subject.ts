import { LunoraError } from "lunorash/errors";

/**
 * The data subject for a call: the signed-in user. Every privacy request is keyed by
 * this id, so a caller can only ever open, read or cancel their own requests.
 */
export const subjectOf = (ctx: { auth: { userId?: null | string } }): string => {
    const { userId } = ctx.auth;

    if (userId === undefined || userId === null || userId === "") {
        throw new LunoraError("UNAUTHENTICATED", "Sign in to manage your data.");
    }

    return userId;
};

/**
 * Milliseconds since the sign-in that issued this session, from the `iat` claim. A
 * session with no `iat` is treated as infinitely old, so an erasure is refused: the
 * package refuses an erasure from a sign-in older than 24 hours.
 */
const sessionAgeMs = async (ctx: { auth: { getIdentity: () => Promise<Record<string, unknown> | null> }; now: number }): Promise<number> => {
    const identity = await ctx.auth.getIdentity();
    const issuedAt = identity?.iat;

    return typeof issuedAt === "number" ? ctx.now - issuedAt * 1000 : Number.POSITIVE_INFINITY;
};

/** The authenticated subject and the age of their sign-in, for the privacy ports. */
export const identityOf = async (ctx: {
    auth: { getIdentity: () => Promise<Record<string, unknown> | null>; userId?: null | string };
    now: number;
}): Promise<{ sessionAgeMs: number; subjectId: string }> => {
    return {
        sessionAgeMs: await sessionAgeMs(ctx),
        subjectId: subjectOf(ctx),
    };
};
