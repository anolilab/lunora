import posthogClient from "posthog-js";

const token = typeof import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN === "string" ? import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN : undefined;
const host = typeof import.meta.env.VITE_PUBLIC_POSTHOG_HOST === "string" ? import.meta.env.VITE_PUBLIC_POSTHOG_HOST : undefined;

/**
 * Whether `posthogClient` was actually initialized in this document.
 *
 * `applyMeasurementConsent` has to know: `opt_in_capturing` on an instance that
 * never loaded is not a no-op, it touches the persistence that `init` creates.
 */
let initialized = false;

if (!import.meta.env.SSR) {
    if (token && host) {
        posthogClient.init(token, {
            // First-party path, proxied to PostHog by `public/_redirects` in
            // production and by `server.proxy` in `vite.config.ts` during dev.
            // Both must carry the rule or captures are silently dropped.
            api_host: "/pr/posthog",
            capture_exceptions: true,
            // Cookieless until the visitor says otherwise: pre-consent and after
            // "Reject", nothing is stored on the device and visitors are counted
            // via PostHog's server-side daily-salted hash instead (requires
            // "Cookieless server hash mode" in the project settings, or those
            // events are dropped). `applyMeasurementConsent` lifts this once
            // c15t reports an explicit "Accept".
            cookieless_mode: "on_reject",
            // `init` runs from a root-route side effect, before hydration. The
            // SDK's default target is `body`, and a script appended there ahead
            // of hydration is a DOM node React did not render — a mismatch.
            // `head` is outside the hydration root. (PostHog's own `defaults`
            // of "2026-01-30" flips this for the same reason; set explicitly so
            // it does not depend on a defaults date we have not opted into.)
            external_scripts_inject_target: "head",
            // No capture and no device storage before an explicit choice. This
            // module is imported for its side effect from the root route, so it
            // runs before the banner has an answer — and it is the only `init`
            // in the app, so these are the only defaults that apply.
            opt_out_capturing_by_default: true,
            opt_out_persistence_by_default: true,
            // Ingestion goes through the proxy above; `host` only drives the
            // "view in PostHog" links the toolbar renders.
            ui_host: host,
        });

        initialized = true;
    } else if (import.meta.env.DEV) {
        // Warn, don't throw. `.env` is gitignored, so a fresh clone has neither
        // variable — throwing here took the whole docs dev server down for any
        // contributor who just wants to edit a page.
        const missing = [token ? undefined : "VITE_PUBLIC_POSTHOG_PROJECT_TOKEN", host ? undefined : "VITE_PUBLIC_POSTHOG_HOST"].filter(Boolean).join(" and ");

        // eslint-disable-next-line no-console -- dev-only diagnostic; the console is the only channel available at module scope before the app mounts
        console.warn(`[posthog] ${missing} not configured — analytics is disabled for this dev session. Set it in apps/docs/.env to enable capture.`);
    }
}

/**
 * Point PostHog at the visitor's measurement decision.
 *
 * Called from `AnalyticsProvider` whenever c15t reports an explicit choice.
 * It lives beside `init` rather than in the provider because a second `init`
 * cannot re-open these settings — posthog-js treats re-initialization as a
 * no-op, so a consent-aware `init` inside a component silently loses to the
 * module-scope one above, which is exactly how the consent state and the
 * running client came apart before.
 */
export const applyMeasurementConsent = (granted: boolean): void => {
    if (!initialized) {
        return;
    }

    if (granted) {
        posthogClient.opt_in_capturing();

        return;
    }

    // Withdrawal must also erase what the accept path persisted (distinct_id,
    // device_id) — opt-out alone only stops capture.
    if (posthogClient.has_opted_in_capturing()) {
        posthogClient.reset(true);
    }

    posthogClient.opt_out_capturing();
};

export { default as posthog } from "posthog-js";
