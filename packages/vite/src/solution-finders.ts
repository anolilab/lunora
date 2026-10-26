import { findLunoraSolution } from "@lunora/codegen";

import type { OverlayPluginOptions } from "./types";

/**
 * A `@visulima/vite-overlay` solution finder. Derived from the overlay's own
 * options type so the shape can't drift from the installed package. The overlay
 * runs every finder it's given (custom finders first, then its built-ins),
 * sorted by `priority` descending, and shows the first non-`undefined` result.
 *
 * Note: this type (and {@link Solution}) is re-exported from `@lunora/vite` and
 * intentionally tracks the installed `@visulima/vite-overlay` — if a future
 * overlay release changes the finder contract, that surfaces here as a compile
 * error rather than a silent drift.
 */
type SolutionFinder = NonNullable<OverlayPluginOptions["solutionFinders"]>[number];

/** What a finder may return: a Markdown-rendered `{ header?, body }`, or `undefined` to defer. */
type Solution = NonNullable<Awaited<ReturnType<SolutionFinder["handle"]>>>;

/**
 * The normalized error a finder receives. The overlay invokes finders
 * **server-side** with a flattened object — not the original `Error` — so the
 * class identity is gone by the time we see it (`error instanceof X` never
 * works here). Codegen/schema failures, which Lunora pushes through
 * `server.hot.send({ type: "error", … })`, arrive with `name === "Error"`, so
 * the class name is useless for matching: we match on the `message` text via
 * `@lunora/codegen`'s shared {@link findLunoraSolution} table. `message` is
 * typed `unknown` because the overlay's own contract passes the error as `any`.
 */
interface NormalizedError {
    message?: unknown;
}

/**
 * Lunora's solution finder for the dev error overlay. A single finder that
 * delegates to `@lunora/codegen`'s shared rule table (the same table the
 * standalone `lunora dev` CLI prints to the terminal) and returns the first
 * match — so one `priority` slot covers every Lunora rule and the overlay's
 * built-in finders still run for anything we don't recognize (we return
 * `undefined`).
 *
 * Priority is high so a Lunora-specific hint wins over the overlay's generic
 * finder for the same error; a user's own finder can still outrank it with a
 * higher `priority`.
 */
const lunoraSolutionFinder: SolutionFinder = {
    // Synchronous body wrapped in `Promise.resolve` rather than `async`: the
    // overlay's `handle` contract is promise-returning, but `require-await` is on
    // for src and there's nothing to await here.
    handle: (error: NormalizedError): Promise<Solution | undefined> => {
        const message = typeof error.message === "string" ? error.message : "";
        const solution = findLunoraSolution(message);

        return Promise.resolve(solution ? { body: solution.body, header: solution.header } : undefined);
    },
    name: "lunora",
    priority: 100,
};

/** The finders Lunora injects into the overlay by default. */
const lunoraSolutionFinders: ReadonlyArray<SolutionFinder> = [lunoraSolutionFinder];

export type { Solution, SolutionFinder };
export { lunoraSolutionFinder, lunoraSolutionFinders };
