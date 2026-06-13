import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckoutButton, CustomerPortalButton, useCheckout } from "../src/payment";

let assignSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

// eslint-disable-next-line vitest/require-top-level-describe -- the location spy is shared across all three describe blocks below, so its setup/teardown lives at the file's top level.
beforeEach(() => {
    assignSpy = vi.fn<(url: string) => void>();

    // jsdom's `window.location.assign` is a non-configurable stub that throws
    // "not implemented"; replace it with a spy so the redirect is observable.
    Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { assign: assignSpy },
        writable: true,
    });
});

// eslint-disable-next-line vitest/require-top-level-describe -- paired with the top-level beforeEach above that owns the shared location spy.
afterEach(() => {
    vi.restoreAllMocks();
});

describe("useCheckout", () => {
    it("runs the trigger and redirects to the resolved url", async () => {
        expect.assertions(3);

        const trigger = vi.fn<() => Promise<{ url: string }>>().mockResolvedValue({ url: "https://pay.example/checkout" });
        const { result } = renderHook(() => useCheckout(trigger));

        expect(result.current.pending).toBe(false);

        await act(async () => {
            await result.current.checkout();
        });

        expect(trigger).toHaveBeenCalledTimes(1);
        expect(assignSpy).toHaveBeenCalledWith("https://pay.example/checkout");
    });

    it("surfaces the error and does not redirect when the trigger rejects", async () => {
        expect.assertions(3);

        const failure = new Error("boom");
        const trigger = vi.fn<() => Promise<{ url: string }>>().mockRejectedValue(failure);
        const { result } = renderHook(() => useCheckout(trigger));

        await act(async () => {
            await expect(result.current.checkout()).rejects.toThrow("boom");
        });

        expect(result.current.error).toBe(failure);
        expect(assignSpy).not.toHaveBeenCalled();
    });
});

describe("checkoutButton", () => {
    it("awaits onCheckout on click, toggles pending, and redirects", async () => {
        // Uses `waitFor` (whose retries make a fixed assertion count nondeterministic).
        expect.hasAssertions();

        let resolveTrigger: ((value: { url: string }) => void) | undefined;
        const trigger = vi.fn<() => Promise<{ url: string }>>().mockImplementation(
            () =>
                new Promise<{ url: string }>((resolve) => {
                    resolveTrigger = resolve;
                }),
        );

        render(<CheckoutButton onCheckout={trigger}>Subscribe</CheckoutButton>);

        const button = screen.getByRole("button", { name: "Subscribe" });

        expect(button.getAttribute("disabled")).toBeNull();

        fireEvent.click(button);

        await waitFor(() => {
            expect(button.getAttribute("aria-busy")).toBe("true");
        });

        await act(async () => {
            resolveTrigger!({ url: "https://pay.example/checkout" });
        });

        expect(trigger).toHaveBeenCalledTimes(1);
        expect(assignSpy).toHaveBeenCalledWith("https://pay.example/checkout");
    });

    it("reports the failure through onError without redirecting", async () => {
        // `waitFor` retries its callback, so a fixed `expect.assertions(n)` count
        // is nondeterministic here — assert that at least one ran instead.
        expect.hasAssertions();

        const failure = new Error("declined");
        const trigger = vi.fn<() => Promise<{ url: string }>>().mockRejectedValue(failure);
        const onError = vi.fn<(error: Error) => void>();

        render(
            <CheckoutButton onCheckout={trigger} onError={onError}>
                Subscribe
            </CheckoutButton>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith(failure);
        });

        expect(assignSpy).not.toHaveBeenCalled();
    });
});

describe("customerPortalButton", () => {
    it("awaits onPortal on click and redirects to the portal url", async () => {
        // `waitFor` retries its callback, so a fixed `expect.assertions(n)` count
        // is nondeterministic here — assert that at least one ran instead.
        expect.hasAssertions();

        const trigger = vi.fn<() => Promise<{ url: string }>>().mockResolvedValue({ url: "https://pay.example/portal" });

        render(<CustomerPortalButton onPortal={trigger}>Manage billing</CustomerPortalButton>);

        fireEvent.click(screen.getByRole("button", { name: "Manage billing" }));

        await waitFor(() => {
            expect(assignSpy).toHaveBeenCalledWith("https://pay.example/portal");
        });

        expect(trigger).toHaveBeenCalledTimes(1);
    });
});
