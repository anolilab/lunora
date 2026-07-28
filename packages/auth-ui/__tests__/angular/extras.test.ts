/**
 * Angular port — the two extras that carry logic rather than markup: the
 * toaster's subscription to the module-level toast store, and One Tap's
 * fire-once gate.
 *
 * As in `bridge.test.ts`, nothing renders here — the templates need the AOT
 * compiler (see that file's header for why it isn't installed), so the classes
 * are driven directly inside an injection context.
 */
import type { Signal } from "@angular/core";
import { Injector, runInInjectionContext } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorToasterComponent, OneTapComponent } from "../../src/angular/extras";
import { provideAuthUI } from "../../src/angular/provider";
import type { AuthClient, Toast } from "../../src/core";
import { pushToast, resetToasts } from "../../src/core";
import { fakeNav, ok } from "../fake-client";

/** The toasts are `protected` — read them the way the template would. */
const toastsOf = (component: ErrorToasterComponent): ReadonlyArray<Toast> => (component as unknown as { toasts: Signal<ReadonlyArray<Toast>> }).toasts();

/** A client with only the method One Tap calls; the flag is set on the provider. */
const oneTapClient = (): { client: AuthClient; oneTap: ReturnType<typeof vi.fn> } => {
    const oneTap = vi.fn(() => ok({ user: { email: "a@b.co" } }));

    return { client: { oneTap } as unknown as AuthClient, oneTap };
};

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetToasts();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
});

describe("error toaster", () => {
    it("mirrors the module-level toast store into a signal", () => {
        expect.assertions(2);

        TestBed.configureTestingModule({ providers: [] });

        const component = runInInjectionContext(TestBed.inject(Injector), () => new ErrorToasterComponent());

        expect(toastsOf(component)).toHaveLength(0);

        pushToast("could not sign in with Google");

        expect(toastsOf(component)[0]?.message).toBe("could not sign in with Google");
    });

    it("stops listening once its scope is destroyed", () => {
        expect.assertions(2);

        TestBed.configureTestingModule({ providers: [] });

        const component = runInInjectionContext(TestBed.inject(Injector), () => new ErrorToasterComponent());

        pushToast("first");

        expect(toastsOf(component)).toHaveLength(1);

        // Destroying the environment injector is what fires the `DestroyRef`
        // hook the component unsubscribes from.
        TestBed.resetTestingModule();
        pushToast("second");

        expect(toastsOf(component)).toHaveLength(1);
    });
});

describe("one tap", () => {
    it("prompts once when the flow is on", async () => {
        expect.assertions(2);

        const fake = oneTapClient();

        TestBed.configureTestingModule({
            providers: [provideAuthUI({ authClient: fake.client, discover: false, nav: fakeNav(), plugins: { oneTap: true } })],
        });
        runInInjectionContext(TestBed.inject(Injector), () => new OneTapComponent());
        TestBed.tick();
        await Promise.resolve();

        expect(fake.oneTap).toHaveBeenCalledWith({ callbackURL: "/" });

        // A second pass must not re-prompt: the gate is derived, the prompt is not.
        TestBed.tick();

        expect(fake.oneTap).toHaveBeenCalledTimes(1);
    });

    it("stays quiet when the flow is off", () => {
        expect.assertions(1);

        const fake = oneTapClient();

        TestBed.configureTestingModule({
            providers: [provideAuthUI({ authClient: fake.client, discover: false, nav: fakeNav(), plugins: { oneTap: false } })],
        });
        runInInjectionContext(TestBed.inject(Injector), () => new OneTapComponent());
        TestBed.tick();

        expect(fake.oneTap).not.toHaveBeenCalled();
    });
});
