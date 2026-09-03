import { useEffect, useEffectEvent, useState } from "react";

import { errorMessage } from "../lib/internal";

/**
 * The resolution of an admin-fetched spec document. `empty` is distinct from
 * `error`: the worker answers a spec-less admin endpoint with a well-formed but
 * operation-less 200 document, so "nothing configured yet" is a clean terminal
 * state, not a failure. `ready` carries the parsed spec for the panel to render.
 */
export type SpecFetchState<T> = { kind: "empty" } | { kind: "error"; message: string } | { kind: "loading" } | { kind: "ready"; spec: T };

/**
 * Resolve the spec an API reference panel renders, shared by the OpenAPI and
 * OpenRPC reference panels. An inline `inlineSpec` (host-provided or the mock
 * harness) is authoritative and classified synchronously; otherwise `fetcher` is
 * called once and its result classified, with the in-flight request cancelled on
 * unmount or when the inputs change so a late resolve never sets state on a gone
 * panel. `classify` maps a resolved spec to the `ready`/`empty` terminal states
 * (each panel detects its own "empty" sentinel — no `paths` vs no `methods`).
 *
 * Neither callback needs to be referentially stable, and the effect is keyed so
 * that it cannot be: `classify` mints a fresh state object, so the settled fetch
 * always re-renders the caller. Keying the effect on the callbacks' identities
 * therefore turned an inline `() => client.fetchOpenApi()` — what both call sites
 * pass — into an unbounded refetch loop, held back only by the build's React
 * Compiler pass, which is configured to bail silently and does not run in tests.
 * The effect reads them through effect events instead, so only `inlineSpec` keys
 * it and a caller cannot get this wrong.
 */
export const useAdminSpec = function <T>(
    inlineSpec: unknown,
    fetcher: () => Promise<unknown>,
    classify: (spec: unknown) => SpecFetchState<T>,
): SpecFetchState<T> {
    // An inline spec resolves synchronously (no fetch); the fetched path starts in
    // `loading` and the effect below resolves it.
    const [fetched, setFetched] = useState<SpecFetchState<T>>({ kind: "loading" });

    const fetchSpec = useEffectEvent(async (): Promise<unknown> => fetcher());
    const classifyFetched = useEffectEvent((spec: unknown): SpecFetchState<T> => classify(spec));

    useEffect(() => {
        // An inline spec is authoritative and handled synchronously below — skip the fetch.
        if (inlineSpec !== undefined) {
            return undefined;
        }

        let cancelled = false;

        fetchSpec()
            .then((spec) => {
                if (!cancelled) {
                    setFetched(classifyFetched(spec));
                }

                return spec;
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setFetched({ kind: "error", message: errorMessage(error) });
                }
            });

        return () => {
            cancelled = true;
        };
    }, [inlineSpec]);

    return inlineSpec === undefined ? fetched : classify(inlineSpec);
};
