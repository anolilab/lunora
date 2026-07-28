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
