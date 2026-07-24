/**
 * Constant-time string comparison — no early return on the first mismatched
 * unit, so the comparison time can't leak how far a secret matched. Used for
 * webhook HMAC signatures and the tail-worker shared secret. Lengths aren't
 * secret, so an early length check is fine; the loop XOR-accumulates per
 * UTF-16 unit. The one canonical copy — never fork a timing-safe primitive.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) {
        return false;
    }

    let diff = 0;

    for (let index = 0; index < a.length; index += 1) {
        // eslint-disable-next-line no-bitwise -- constant-time comparison requires bitwise accumulation
        diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
    }

    return diff === 0;
};
