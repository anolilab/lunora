import { useEffect, useState } from "react";

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
 * `fetcher` and `classify` must be stable (a `useCallback`-wrapped client call
 * and a module-level classifier) so the effect doesn't re-fetch every render.
 */
export const useAdminSpec = function <T>(
    inlineSpec: unknown,
    fetcher: () => Promise<unknown>,
    classify: (spec: unknown) => SpecFetchState<T>,
): SpecFetchState<T> {
    // An inline spec resolves synchronously (no fetch); the fetched path starts in
    // `loading` and the effect below resolves it.
    const [fetched, setFetched] = useState<SpecFetchState<T>>({ kind: "loading" });

    useEffect(() => {
        // An inline spec is authoritative and handled synchronously below — skip the fetch.
        if (inlineSpec !== undefined) {
            return undefined;
        }

        let cancelled = false;

        fetcher()
            .then((spec) => {
                if (!cancelled) {
                    setFetched(classify(spec));
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
    }, [classify, fetcher, inlineSpec]);

    return inlineSpec === undefined ? fetched : classify(inlineSpec);
};
