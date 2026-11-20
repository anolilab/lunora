import { describe, expect, it, vi } from "vitest";

import dispatcher from "../src/dispatcher/worker";

/**
 * With no egress policy the dispatch options must be exactly what they were
 * before plan 477: `{ limits, outbound: { lineage } }` and no `egress` key. The
 * policy path is covered at the value level (`egress-policy.test.ts`) and through
 * `serve` in `dispatcher-admission.test.ts`.
 */

type Options = { limits?: unknown; outbound?: Record<string, unknown> };

const makeEnv = () => {
    const get = vi.fn<(name: string, args?: unknown, options?: Options) => { fetch: () => Promise<Response> }>(() => {
        return {
            fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
        };
    });

    // `development` serves the free tier without a control plane; outside it a missing control plane refuses.
    return { DISPATCHER: { get }, LUNORA_APP_DOMAIN: "lunora.app", LUNORA_ENVIRONMENT: "development", get };
};

describe("dispatcher egress wiring without a policy", () => {
    it("passes lineage as the only outbound parameter", async () => {
        const env = makeEnv();

        await dispatcher.fetch(new Request("https://acme.lunora.app/api"), env);

        const options = env.get.mock.calls[0]?.[2];

        expect(options?.outbound).toStrictEqual({ lineage: expect.stringMatching(/^0\.[0-9a-f]{32}$/) });
        expect(Object.keys(options?.outbound ?? {})).toStrictEqual(["lineage"]);
    });
});
