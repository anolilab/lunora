/**
 * Angular port — the DI + signal bridge (`provideAuthUI` / `injectAuthUI` /
 * `controllerSignal`). That bridge is the port's only real logic: the cards
 * above it are markup binding signals the other four ports already prove out
 * through the shared controllers.
 *
 * **Template rendering is deliberately not covered here.** The cards use signal
 * inputs (`input()`), and initializer-based APIs are invisible to Angular's JIT
 * compiler — every binding fails with NG0303. Compiling them needs
 * `@analogjs/vite-plugin-angular` + `@angular/build`, which pulls the Angular
 * CLI build system (and an lmdb native build) into every install in this
 * monorepo. That trade wasn't worth it for markup assertions; the Angular
 * templates are checked where they run, in a consumer's app, plus `tsc` over
 * this port.
 */
import { DestroyRef, Injector, runInInjectionContext } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { controllerSignal } from "../../src/angular/controller-signal";
import { injectAuthUI, provideAuthUI } from "../../src/angular/provider";
import { createSignInController, resetFlowWarnings } from "../../src/core";
import type { FakeClient } from "../fake-client";
import { bareClient, fakeNav, pluginClient } from "../fake-client";

/** Hoisted so the assertion doesn't recompile it per call. */
const PROVIDE_AUTH_UI = /provideAuthUI/u;

const withProvider = <T>(fake: FakeClient, run: () => T, extra: Record<string, unknown> = {}): T => {
    TestBed.configureTestingModule({ providers: [provideAuthUI({ authClient: fake.client, nav: fakeNav(), ...extra })] });

    return runInInjectionContext(TestBed.inject(Injector), run);
};

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetFlowWarnings();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
});

describe("provideAuthUI / injectAuthUI", () => {
    it("resolves a fully defaulted context from DI", () => {
        expect.assertions(3);

        const context = withProvider(bareClient(), () => injectAuthUI());

        expect(context.basePath).toBe("/api/auth");
        expect(context.redirects.afterSignIn).toBe("/");
        expect(context.localization.signIn).toBe("Sign in");
    });

    it("throws a useful error when the provider is missing", () => {
        expect.assertions(1);

        TestBed.configureTestingModule({ providers: [] });

        expect(() => runInInjectionContext(TestBed.inject(Injector), () => injectAuthUI())).toThrow(PROVIDE_AUTH_UI);
    });

    it("carries the client's registered plugin flags through DI", () => {
        expect.assertions(2);

        expect(withProvider(pluginClient(), () => injectAuthUI()).plugins.magicLink).toBe(true);

        // A second configureTestingModule needs a fresh TestBed.
        TestBed.resetTestingModule();

        expect(withProvider(bareClient(), () => injectAuthUI()).plugins.magicLink).toBe(false);
    });

    it("carries the resolved theme variables through DI", () => {
        expect.assertions(1);

        const context = withProvider(bareClient(), () => injectAuthUI(), {
            theme: (defaults: Record<string, string>) => {
                return { ...defaults, primary: "#000" };
            },
        });

        expect(context.themeVariables).toStrictEqual({ "--primary": "#000" });
    });
});

describe("controllerSignal", () => {
    it("mirrors controller state into a signal and forwards actions", async () => {
        expect.assertions(3);

        const fake = bareClient();
        const bridge = withProvider(fake, () => controllerSignal(createSignInController));

        expect(bridge.state().status).toBe("idle");

        bridge.actions.setField("email", "a@b.co");
        bridge.actions.setField("password", "hunter2hunter2");

        // The signal tracks the controller's pushes, not a stale first snapshot.
        expect(bridge.state().fields.email.value).toBe("a@b.co");

        await bridge.actions.submit();

        expect(fake.signInEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "a@b.co" }));
    });

    it("unsubscribes and destroys the controller when the scope is destroyed", () => {
        expect.assertions(2);

        const fake = bareClient();
        let destroyed = false;

        TestBed.configureTestingModule({ providers: [provideAuthUI({ authClient: fake.client, nav: fakeNav() })] });

        const injector = TestBed.inject(Injector);
        const bridge = runInInjectionContext(injector, () =>
            controllerSignal((context) => {
                const controller = createSignInController(context);

                return {
                    ...controller,
                    destroy: () => {
                        destroyed = true;
                        controller.destroy();
                    },
                };
            }),
        );

        expect(bridge.state().status).toBe("idle");

        TestBed.inject(DestroyRef).onDestroy(() => undefined);
        TestBed.resetTestingModule();

        expect(destroyed).toBe(true);
    });
});
