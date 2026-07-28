import { afterEach, describe, expect, it, vi } from "vitest";

import { CAPTCHA_HEADER, captchaHeaders, dismissToast, getToasts, pushToast, resetToasts, setCaptchaToken, subscribeToasts } from "../../src/core";

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetToasts();
    setCaptchaToken(undefined);
    vi.useRealTimers();
});

describe("toast store", () => {
    it("holds a pushed message and dismisses it by id", () => {
        expect.assertions(3);

        const id = pushToast("nope");

        expect(getToasts()).toHaveLength(1);
        expect(getToasts()[0]?.message).toBe("nope");

        dismissToast(id);

        expect(getToasts()).toHaveLength(0);
    });

    it("collapses an identical consecutive message", () => {
        expect.assertions(2);

        // A user clicking a broken social button three times should see one
        // toast, not a stack of the same sentence.
        const first = pushToast("same");
        const second = pushToast("same");

        expect(getToasts()).toHaveLength(1);
        expect(second).toBe(first);
    });

    it("keeps distinct messages apart", () => {
        expect.assertions(1);

        pushToast("one");
        pushToast("two");

        expect(getToasts()).toHaveLength(2);
    });

    it("dismisses itself after the timeout", () => {
        expect.assertions(2);

        vi.useFakeTimers();
        pushToast("temporary");

        expect(getToasts()).toHaveLength(1);

        vi.advanceTimersByTime(6001);

        expect(getToasts()).toHaveLength(0);
    });

    it("notifies subscribers on push and dismiss", () => {
        expect.assertions(1);

        const onChange = vi.fn();
        const stop = subscribeToasts(onChange);
        const id = pushToast("watched");

        dismissToast(id);
        stop();

        expect(onChange).toHaveBeenCalledTimes(2);
    });
});

describe("captchaHeaders", () => {
    it("is empty when nothing has been solved", () => {
        expect.assertions(1);

        expect(captchaHeaders()).toStrictEqual({});
    });

    it("returns the token under the header better-auth reads", () => {
        expect.assertions(1);

        setCaptchaToken("solved");

        expect(captchaHeaders()).toStrictEqual({ [CAPTCHA_HEADER]: "solved" });
    });

    it("consumes the token, because these providers issue single-use ones", () => {
        expect.assertions(2);

        setCaptchaToken("once");

        expect(captchaHeaders()).toStrictEqual({ [CAPTCHA_HEADER]: "once" });
        // Sending the same token twice fails verification on the second request,
        // so a second read must not resend it.
        expect(captchaHeaders()).toStrictEqual({});
    });
});

describe("prefill vs the user", () => {
    it("does not let a late prefill overwrite what the user typed", async () => {
        expect.assertions(2);

        const { createFormController, resolveContext } = await import("../../src/core");

        let release: (value: { name: string }) => void = () => {};
        const prefilled = new Promise<{ name: string }>((resolve) => {
            release = resolve;
        });

        const context = resolveContext({
            authClient: { getSession: vi.fn() } as never,
            nav: { navigate: vi.fn(), replace: vi.fn() },
        });

        const controller = createFormController<"name">(context, {
            fallbackError: (localization) => localization.genericError,
            fields: { name: {} },
            prefill: async () => prefilled,
            submit: () => Promise.resolve(undefined),
        });

        // The user types while the session read is still in flight — the exact
        // ordering that made a saved profile name silently revert.
        controller.actions.setField("name", "Renamed Tester");
        release({ name: "stale-from-the-server" });
        await prefilled;

        expect(controller.getState().fields.name.value).toBe("Renamed Tester");

        // A field they never touched is still seeded, which is the point of prefill.
        const untouched = createFormController<"name">(context, {
            fallbackError: (localization) => localization.genericError,
            fields: { name: {} },
            prefill: () => Promise.resolve({ name: "from-the-server" }),
            submit: () => Promise.resolve(undefined),
        });

        await untouched.actions.load();

        expect(untouched.getState().fields.name.value).toBe("from-the-server");
    });
});
