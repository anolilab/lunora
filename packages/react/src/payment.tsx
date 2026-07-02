"use client";

import type { ReactNode } from "react";
import { useCallback, useState } from "react";

/**
 * Client-safe mirror of `@lunora/payment`'s `Subscription`. Re-declared here
 * (rather than imported) so this React entry never pulls in the server-only
 * `@lunora/payment` module graph — the kit stays React + DOM only. Keep this in
 * sync with `packages/payment/src/types.ts`.
 */
interface Subscription {
    readonly cancelAtPeriodEnd: boolean;
    readonly createdAt: number;
    readonly currentPeriodEnd?: number;
    readonly id: string;
    readonly priceId: string;
    readonly provider: "polar" | "stripe";
    readonly quantity: number;
    readonly referenceId: string;
    readonly state: "active" | "canceled" | "past_due" | "paused" | "trialing";
    readonly updatedAt: number;
}

/** The `{ url }` shape every checkout/portal trigger resolves to. */
interface RedirectTarget {
    readonly url: string;
}

/** A thunk the app supplies that calls its own Lunora action and resolves a redirect URL. */
type RedirectTrigger = () => Promise<RedirectTarget>;

interface UseCheckoutResult {
    /** Run the trigger and redirect the browser to the resolved URL. Resolves once the redirect is issued; rejects on failure. */
    checkout: () => Promise<void>;
    /** The most recent failure, or `undefined`. */
    error: Error | undefined;
    /** `true` while the trigger is in flight (before the redirect is issued). */
    pending: boolean;
}

/**
 * Resolve a redirect target to a safe href, throwing on a non-http(s) scheme.
 * The `url` is expected to be a provider-hosted checkout/portal URL from the
 * app's own action, but a compromised/misconfigured server could return a
 * `javascript:`/`data:` URL — this keeps such a value out of `location.assign`.
 * Kept at module scope (not an inline `throw`) so `useCheckout` stays
 * React-Compiler-optimizable.
 */
const safeRedirectHref = (url: string): string => {
    const parsed = new URL(url, globalThis.location.href);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`refusing to redirect to a non-http(s) URL: ${parsed.protocol}`);
    }

    return parsed.href;
};

/**
 * Decoupled redirect-on-resolve primitive shared by `CheckoutButton` and
 * `CustomerPortalButton`. The app passes a `trigger` thunk that calls its own
 * Lunora action (the one wrapping `LunoraPayment.createCheckout` /
 * `createPortalSession`) and resolves `{ url }`; this hook awaits it, flips
 * `pending`, surfaces any `error`, and on success navigates via
 * `location.assign(url)`.
 *
 * Mirrors Convex's `CheckoutLink` / `CustomerPortalLink` flow (trigger an action
 * that returns a URL, then redirect) while staying agnostic of the app's
 * function names.
 */
const useCheckout = (trigger: RedirectTrigger): UseCheckoutResult => {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<Error | undefined>(undefined);

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing: the `try { … } finally { … }` below bails React Compiler for the whole `useCheckout` hook (it can't lower a TryStatement with a finalizer yet), so this `useCallback` is the only thing keeping `checkout`'s identity stable. Keep it.
    const checkout = useCallback(async (): Promise<void> => {
        setPending(true);
        setError(undefined);

        // react-doctor-disable-next-line react-hooks-js/todo -- the `finally { setPending(false) }` guarantees the pending flag always clears (success, redirect, or throw); the compiler can't lower a try/finally yet, but the finalizer is required semantics, not optimizable-away.
        try {
            const target = await trigger();

            // Validate the scheme via a module-level helper (not an inline
            // `throw`) — a literal ThrowStatement inside try/catch defeats the
            // React Compiler's memoization of this hook, whereas a throwing call
            // is fine. `safeRedirectHref` rejects non-http(s) URLs so a
            // compromised action can't drive `location.assign` to `javascript:`.
            globalThis.location.assign(safeRedirectHref(target.url));
        } catch (error_: unknown) {
            const normalized = error_ instanceof Error ? error_ : new Error(String(error_));

            setError(normalized);

            throw normalized;
        } finally {
            setPending(false);
        }
    }, [trigger]);

    return { checkout, error, pending };
};

/**
 * Presentational props shared by the redirect buttons. Kept to a curated set
 * (rather than spreading arbitrary button attributes) so the component stays
 * within the repo's `react/jsx-props-no-spreading` rule while covering the
 * common styling / accessibility hooks.
 */
interface RedirectButtonOwnProps {
    /** Accessible label when the visible `children` are icon-only. */
    "aria-label"?: string;
    children?: ReactNode;
    className?: string;
    /** Force-disable the control regardless of pending state. */
    disabled?: boolean;
    /** Called with the failure when the trigger rejects. The error is also surfaced via `useCheckout`. */
    onError?: (error: Error) => void;
    title?: string;
}

interface RedirectButtonProps extends RedirectButtonOwnProps {
    /** The thunk to await on click; on success the browser is redirected to its `url`. */
    trigger: RedirectTrigger;
}

interface CheckoutButtonProps extends RedirectButtonOwnProps {
    /** Calls the app's checkout action and resolves the hosted-checkout `{ url }`. */
    onCheckout: RedirectTrigger;
}

interface CustomerPortalButtonProps extends RedirectButtonOwnProps {
    /** Calls the app's portal action and resolves the customer-portal `{ url }`. */
    onPortal: RedirectTrigger;
}

/**
 * Headless-ish button element that awaits `trigger` on click and redirects to
 * the resolved URL. Disabled while pending (and respects an externally-passed
 * `disabled`), with `aria-busy` reflecting the in-flight state.
 */
const RedirectButton = ({ "aria-label": ariaLabel, children, className, disabled, onError, title, trigger }: RedirectButtonProps): ReactNode => {
    const { checkout, pending } = useCheckout(trigger);

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- kept deliberately: although React Compiler memoizes this component, ESLint's `react-perf/jsx-no-new-function-as-prop` (a static rule that can't see the compiler) requires memoized function props like the `onClick` below. Keep `useCallback` to satisfy that hard lint gate.
    const handleClick = useCallback((): void => {
        checkout().catch((error: unknown) => {
            const normalized = error instanceof Error ? error : new Error(String(error));

            onError?.(normalized);
        });
    }, [checkout, onError]);

    return (
        <button
            aria-busy={pending}
            aria-label={ariaLabel}
            className={className}
            disabled={disabled === true || pending}
            onClick={handleClick}
            title={title}
            type="button"
        >
            {children}
        </button>
    );
};

/**
 * Button that starts a hosted checkout. On click it awaits `onCheckout` (a thunk
 * that calls the app's checkout action) and redirects to the returned URL,
 * disabling itself while the request is in flight.
 */
const CheckoutButton = ({ onCheckout, ...rest }: CheckoutButtonProps): ReactNode => {
    const { "aria-label": ariaLabel, children, className, disabled, onError, title } = rest;

    return (
        <RedirectButton aria-label={ariaLabel} className={className} disabled={disabled} onError={onError} title={title} trigger={onCheckout}>
            {children}
        </RedirectButton>
    );
};

/**
 * Button that opens the provider's customer portal. On click it awaits
 * `onPortal` (a thunk that calls the app's portal action) and redirects to the
 * returned URL, disabling itself while the request is in flight.
 */
const CustomerPortalButton = ({ onPortal, ...rest }: CustomerPortalButtonProps): ReactNode => {
    const { "aria-label": ariaLabel, children, className, disabled, onError, title } = rest;

    return (
        <RedirectButton aria-label={ariaLabel} className={className} disabled={disabled} onError={onError} title={title} trigger={onPortal}>
            {children}
        </RedirectButton>
    );
};

export type { CheckoutButtonProps, CustomerPortalButtonProps, RedirectTarget, RedirectTrigger, Subscription, UseCheckoutResult };
// eslint-disable-next-line react-refresh/only-export-components -- useCheckout is the shared hook these buttons build on and is part of the kit's public API; colocating it with the buttons keeps the payment surface in one module (same pattern as useLunora alongside LunoraProvider).
export { CheckoutButton, CustomerPortalButton, useCheckout };
