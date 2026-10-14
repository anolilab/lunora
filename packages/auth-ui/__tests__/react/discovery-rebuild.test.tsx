import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetAuthConfigDiscovery } from "../../src/core";
import { AuthUIProvider, SignInCard } from "../../src/react";
import { bareClient, fakeNav } from "../fake-client";

/**
 * Plan 278 (c) — measured, not fixed.
 *
 * `provider.tsx`'s `core` memo keys on `discoveryKey`, so the arrival of the
 * server's `/ui-config` answer rebuilds every controller memoized on it from
 * `initialState()` — including whatever the user already typed. The mechanism
 * is certain (see `provider.tsx`'s `discoveryKey` comment); this test pins the
 * measured* window instead of "fixing" it, per plan 278 §5 S3.
 *
 * Why "accept" rather than fix A (stable accessor) or fix B (re-seed): the
 * request is a same-origin GET fired on provider mount (`provider.tsx:131`),
 * so on a healthy deployment it resolves in the tens-of-milliseconds range —
 * well before a human reads a label, moves focus, and types. The realistic
 * risk window is therefore narrow for manual typing. It is *not* narrow for a
 * password manager's autofill, which can land within the same tick as mount —
 * that case can still lose a race with the network. Both fix directions carry
 * their own cost: fix A threads an accessor through `ControllerContext`'s
 * public field shape (a ripple through every controller and all five ports —
 * flagged as a plan 278 §8 STOP condition on its own); fix B needs a generic
 * `seed`/`hydrate` seam on `Controller` that would have to make sense for
 * every domain controller's state shape, not just form fields (a resource
 * controller's in-flight loading state, an upload controller's `File` handle,
 * …). Neither is a change to make inside this plan without a wider design
 * pass, so (c) is accepted here: this test documents the trade-off rather
 * than asserting a bug, and the same note lives beside `discoveryKey` in
 * `provider.tsx`. A follow-up plan is the right place to revisit fix A/B if
 * the autofill case turns out to matter in practice.
 */
describe("discovery rebuild vs in-flight form state (documented trade-off, not a regression)", () => {
    afterEach(() => {
        resetAuthConfigDiscovery();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("clears a field typed before a late-arriving discovery answer settles", async () => {
        let resolveFetch: ((value: unknown) => void) | undefined;

        vi.stubGlobal(
            "fetch",
            vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveFetch = resolve;
                    }),
            ),
        );

        const { client } = bareClient();

        const tree: ReactElement = (
            <AuthUIProvider authClient={client} nav={fakeNav()} redirects={{ afterSignIn: "/app" }}>
                <SignInCard />
            </AuthUIProvider>
        );

        render(tree);

        // Typed while discovery is still in flight — the realistic case for a
        // fast human or an autofilling password manager.
        fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });

        expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("ada@example.com");

        // The answer lands late. `resolveFetch` is guaranteed set: `fetch` is
        // called synchronously from the effect-less `useMemo` on mount.
        resolveFetch?.({
            json: async () => {
                return { emailAndPassword: true, plugins: [], signUp: true, socialProviders: [] };
            },
            ok: true,
        });

        await waitFor(() => {
            // The rebuilt controller starts from `initialState()` again — this
            // is the accepted trade-off, not the desired outcome. If this ever
            // starts failing because the field survived, that is fix A/B
            // having landed elsewhere; update this test's framing rather than
            // treating the new (better) behaviour as a regression.
            expect(screen.getByLabelText<HTMLInputElement>("Email").value).toBe("");
        });
    });
});
