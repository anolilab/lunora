/**
 * Canonical constant-time string equality shared across `@lunora/do` (relay hub,
 * ShardDO, SessionDO) and any other package that compares a secret/token against
 * a caller-supplied value.
 *
 * Compares the full length (capped at the longer input) and folds a length
 * mismatch into the accumulator, so unequal-length strings take the same number
 * of XOR ops as equal-length ones — a shorter candidate cannot short-circuit the
 * loop, and the compare never leaks match progress or length via an early exit.
 * This is a security-relevant primitive, so it must have exactly ONE definition
 * rather than byte-similar copies that can drift (an earlier relay-hub copy
 * returned early on a length mismatch, diverging from the DO copies).
 *
 * Like `shared/quote-identifier.ts`, it is deliberately **not** a package:
 * consumers on the same tier import this file by relative path and the bundler
 * (packem/rollup) inlines it — no runtime dependency edge, duplicated only in
 * emitted output. Keep it genuinely zero-dependency (relative/built-in imports
 * only) or inlining breaks. Consumers must drop `outDir`/`rootDir` from their
 * `tsconfig.json` (a set `rootDir` raises TS6059 for this out-of-package file
 * under `tsc --noEmit`).
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
    const max = Math.max(a.length, b.length);
    // eslint-disable-next-line no-bitwise -- constant-time compare folds length + every code-unit delta into one accumulator
    let diff = a.length ^ b.length;

    for (let index = 0; index < max; index += 1) {
        // charCodeAt returns NaN past the end of the string; coerce to 0
        // so the XOR still folds into `diff` without poisoning it.
        // eslint-disable-next-line unicorn/prefer-code-point -- compare per UTF-16 code unit so timing stays independent of surrogate boundaries
        const charA = index < a.length ? a.charCodeAt(index) : 0;
        // eslint-disable-next-line unicorn/prefer-code-point -- compare per UTF-16 code unit so timing stays independent of surrogate boundaries
        const charB = index < b.length ? b.charCodeAt(index) : 0;

        // eslint-disable-next-line no-bitwise -- accumulate per-code-unit difference without branching to keep the compare constant-time
        diff |= charA ^ charB;
    }

    return diff === 0;
};
