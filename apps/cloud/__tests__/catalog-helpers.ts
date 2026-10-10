/**
 * The verified branch of a catalog result. Throws when the result is a refusal, so
 * an assertion on the verified value never sits inside a conditional.
 */
const okOf = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
    if (!result.ok) {
        throw new Error("expected a verified result, got a refusal");
    }

    return result as Extract<T, { ok: true }>;
};

export default okOf;
