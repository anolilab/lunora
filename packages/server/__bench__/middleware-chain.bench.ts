import { bench, describe } from "vitest";

import type { Middleware } from "../src/index.js";
import { initCirrus } from "../src/index.js";

/**
 * The procedure builder's `.use(mw)` chain composes middleware onion-style;
 * every layer adds one `await` + one allocation per call. RLS, ratelimit,
 * logging, and observability all plug in here, so real apps stack 2-6 layers.
 * The bench measures how the dispatch cost grows with N.
 *
 *  - **N=0** — no .use; the dispatch floor.
 *  - **N=1** — one passthrough middleware (`async ({next}) => next()`).
 *  - **N=4** — four passthroughs; typical app.
 *  - **N=8** — eight; sanity check that the cost stays roughly linear.
 *
 * Each layer's handler is `next()` only — we're isolating the runner, not
 * user code inside the middleware.
 */

const cirrus = initCirrus.dataModel<Record<string, never>>().create();

// Cast through `Middleware<any, any>` so the chain accepts a passthrough
// without the builder narrowing ctx to `unknown` at the terminal — same
// pattern the rls test harness uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const passthrough = (async (options: { ctx: unknown; next: () => Promise<unknown> }) => options.next()) as Middleware<any, any>;

const buildHandler = (count: number) => {
    // Each `.use(...)` widens the chain's ctx type; for a passthrough we
    // erase it at the boundary so the terminal stays callable. Real apps
    // type their middleware concretely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let builder = cirrus.query as any;

    for (let index = 0; index < count; index += 1) {
        builder = builder.use(passthrough);
    }

    return builder.query(async () => 42) as { handler: (ctx: never, args: Record<string, unknown>) => Promise<unknown> };
};

const n0 = buildHandler(0);
const n1 = buildHandler(1);
const n4 = buildHandler(4);
const n8 = buildHandler(8);

const fakeCtx = {} as never;

describe("builder middleware chain — N=0/1/4/8 dispatch cost", () => {
    bench("N=0: no .use (dispatch floor)", async () => {
        await n0.handler(fakeCtx, {});
    });

    bench("N=1: one passthrough middleware", async () => {
        await n1.handler(fakeCtx, {});
    });

    bench("N=4: four passthrough middlewares", async () => {
        await n4.handler(fakeCtx, {});
    });

    bench("N=8: eight passthrough middlewares", async () => {
        await n8.handler(fakeCtx, {});
    });
});
