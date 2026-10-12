import type { Mock } from "vitest";
import { vi } from "vitest";

import type { FetchLike } from "../../src/egress/forward";

/**
 * Shared by the egress suites (plan 477): the origin most cases call, a generator for
 * long user lists, and an injected upstream fetch that records each hop.
 */

/** The origin most egress cases call. */
export const API = "https://api.example.com";

/** `count` distinct user origins, `https://h0.example.com` onwards. */
export const userOrigins = (count: number): string[] => Array.from({ length: count }, (_, index) => `https://h${String(index)}.example.com`);

/** A redirect response to `location`. */
export const redirect = (location: string, status = 302): Response => new Response(null, { headers: { location }, status });

/**
 * An injected upstream fetch. The Nth call is answered by `respond(N, request)`, so a
 * test can record what each hop sent (read the request, or `mock.calls`) and answer it.
 * Each hop is answered by index, so a response is never handed to two hops.
 */
export const recordingUpstream = (respond: (hop: number, request: Request) => Promise<Response> | Response): Mock<FetchLike> => {
    let hop = 0;

    return vi.fn<FetchLike>(async (request) => {
        const index = hop;

        hop += 1;

        return respond(index, request);
    });
};

/** An upstream that answers hop N with `responses[N]`, then 200 once the list runs out. */
export const scriptedUpstream = (...responses: Response[]): Mock<FetchLike> =>
    recordingUpstream((hop) => responses[hop] ?? new Response("end", { status: 200 }));
