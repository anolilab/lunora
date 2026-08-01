/**
 * Fixture simulating the Node `^22.15.0` floor failure: on that floor,
 * `import()`ing a `.ts` file with no runtime TS loader throws
 * `ERR_UNKNOWN_FILE_EXTENSION` — Vitest transforms real `.ts` on import, so
 * this fixture throws the identically-shaped error itself at module-
 * evaluation time, which makes the runner's `import()` call reject with
 * exactly what it would see on the real floor. Used by
 * `packages/cli/__tests__/commands/eval.test.ts` to prove the runner surfaces
 * one distinct, actionable message and aborts, instead of mislabeling this
 * (and every other discovered eval) as a per-eval "failed" outcome.
 */
const floorError = new TypeError('Unknown file extension ".ts" for /fake/evals/floor.eval.ts') as NodeJS.ErrnoException;

floorError.code = "ERR_UNKNOWN_FILE_EXTENSION";

throw floorError;
