import posthogClient from "posthog-js";

import { redactOrgPath } from "./tabs";

/**
 * Product analytics for the hosted studio.
 *
 * Deliberately NOT the `apps/docs` configuration, which is tuned for a public
 * marketing site with a cookie banner. This is an authenticated control plane
 * whose screens render other people's data — tenant log lines, trace payloads,
 * secret names, deploy keys, custom hostnames. The two risks that matters for
 * are autocapture and session replay, and they are handled differently here:
 *
 *  - **Autocapture is off.** It records the text and attributes of whatever was
 *    clicked. On the Logs tab that is a tenant's log line; on Secrets it is a
 *    secret name. Every event this app sends is one written by hand, so the
 *    payload is a decision someone made rather than whatever happened to be in
 *    the DOM.
 *  - **Session replay masks by default and unmasks by exception.** See
 *    {@link maskText}.
 *
 * Absent configuration the module is inert: no token, no init, no capture, and
 * every helper below is a no-op. A cell that has not been given a PostHog
 * project runs exactly as it did before this existed.
 */

const token = typeof import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN === "string" ? import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN : undefined;
const host = typeof import.meta.env.VITE_PUBLIC_POSTHOG_HOST === "string" ? import.meta.env.VITE_PUBLIC_POSTHOG_HOST : undefined;

/**
 * Session replay is **off unless explicitly switched on**, and stays that way
 * even when a PostHog project is configured.
 *
 * Replay of an identified operator is the highest-risk processing this app
 * does: masked or not, it is a recording of a named person working. Every other
 * event here is a counter that legitimate interest covers comfortably; a
 * recording is the one that a supervisory authority expects consent, a DPIA, or
 * both for. So it is a separate, deliberate switch rather than something that
 * arrives with a project token — and the masking below is the safety belt for
 * when someone flips it, not a licence to leave it on.
 */
const sessionReplayEnabled = import.meta.env.VITE_PUBLIC_POSTHOG_SESSION_REPLAY === "true";

/**
 * Marks a subtree whose text is safe to record in a session replay.
 *
 * An attribute rather than a class so it cannot be swept up by a styling
 * refactor, and so a reviewer reading the JSX sees a deliberate disclosure
 * rather than a utility class.
 */
const UNMASK_ATTRIBUTE = "data-ph-unmask";

/** What a masked text node is replaced with. Same length, so the replay's layout still reads as a layout. */
const maskCharacter = "•";

/**
 * Mask every text node unless it is inside an explicitly unmasked subtree.
 *
 * This is the inversion that makes replay safe to leave on. The obvious
 * configuration — `maskTextSelector` listing the panels that hold tenant data —
 * is an allowlist of things to HIDE, so a panel added later is recorded until
 * someone remembers to add it, and the failure is silent and retroactive: the
 * recording already left the browser.
 *
 * Here the default is masked and `data-ph-unmask` is the exception, so a new
 * screen leaks nothing on the day it ships. What is unmasked is navigation
 * chrome and static labels — enough to see WHICH screen someone was on and
 * which control they were reaching for, which is the question a replay is for.
 */
const maskText = (text: string, element?: HTMLElement | null): string => (element?.closest(`[${UNMASK_ATTRIBUTE}]`) ? text : maskCharacter.repeat(text.length));

/**
 * The properties PostHog attaches by itself that hold a URL, and therefore an
 * organization id. See {@link redactOrgPath} for why they are rewritten.
 */
const URL_PROPERTIES = ["$current_url", "$initial_current_url", "$pathname", "$initial_pathname", "$referrer", "$initial_referrer"];

/**
 * Rewrite the auto-attached properties. Returns a copy — the SDK hands us its own object.
 *
 * Two jobs: redact the organization id out of the URLs (see
 * {@link redactOrgPath}), and drop the IP address. `$ip: null` is the
 * client-side request not to store it; the authoritative control is the
 * project's own **Discard client IP data** setting, because the address is
 * visible to the ingest endpoint either way and only the project setting stops
 * it being retained. Both are set, so neither is a single point of failure.
 */
const sanitizeProperties = (properties: Record<string, unknown>): Record<string, unknown> => {
    const sanitized: Record<string, unknown> = { ...properties, $ip: null };

    for (const key of URL_PROPERTIES) {
        const value = sanitized[key];

        if (typeof value === "string") {
            sanitized[key] = redactOrgPath(value);
        }
    }

    return sanitized;
};

/** Whether `posthogClient.init` actually ran. Every helper checks it: calling into an uninitialized client touches persistence `init` is supposed to create. */
let initialized = false;

if (!import.meta.env.SSR && token && host) {
    posthogClient.init(token, {
        // Feature flags and surveys are unused, and each is an extra request
        // that carries the distinct id to a third party for nothing. Off.
        advanced_disable_feature_flags: true,
        api_host: host,
        // Off, and the reason is the whole point of this file — see the module
        // docblock. Manual events only.
        autocapture: false,
        // Unhandled errors and rejections. The message and stack are the app's
        // own; no DOM text rides along.
        capture_exceptions: true,
        // The router owns navigation, so PostHog's own listener would miss
        // client-side transitions and double-count the first load. `__root.tsx`
        // sends `$pageview` from a route effect instead — the standard event
        // name, so Paths and funnels work, with a redacted URL (below) and a
        // stable `screen` name rather than an id-bearing path.
        capture_pageview: false,
        // `init` runs before hydration; the SDK's default script target is
        // `body`, and a node appended there that React did not render is a
        // hydration mismatch.
        // See `sessionReplayEnabled` — off by default, by design.
        disable_session_recording: !sessionReplayEnabled,
        disable_surveys: true,
        external_scripts_inject_target: "head",
        // Only sign-in operators become person profiles. The default (`always`)
        // would profile every visitor to the login page, which is a person
        // record created for someone who never got in.
        person_profiles: "identified_only",

        /**
         * **No cookie, no localStorage, no sessionStorage.** This is the choice
         * that keeps the studio out of ePrivacy Art. 5(3) consent territory
         * altogether: nothing is stored on the operator's device, so there is
         * no banner to show and nothing to ask permission for.
         *
         * The cost is small here and worth naming. A distinct id held in memory
         * does not survive a reload, so each page load starts anonymous — but
         * the org layout calls {@link identifyOperator} on mount, so in practice
         * every session is attributed within a render, and cross-session
         * stitching happens on PostHog's side by user id. What is genuinely
         * lost is pre-login attribution: an operator's path through the login
         * page cannot be joined to the session that follows it.
         *
         * `cookieless_mode: "on_reject"` is the alternative if a consent banner
         * is ever added — it uses cookies for operators who accept and a
         * server-side hash for those who do not. It needs a project-side
         * setting enabled to work at all, so it is not the safe default.
         */
        persistence: "memory",
        // Honour the browser's Do Not Track. Combined with the memory-only
        // persistence above this is the operator's opt-out channel until a
        // settings toggle exists (GDPR Art. 21).
        respect_dnt: true,
        sanitize_properties: sanitizeProperties,
        session_recording: {
            // Inputs are masked wholesale — a form field on this app is a
            // hostname, a secret value, or a search over tenant logs.
            maskAllInputs: true,
            maskTextFn: maskText,
            // Every element is a masking candidate; `maskTextFn` decides.
            maskTextSelector: "*",
        },
    });

    initialized = true;
}

/**
 * Attach the signed-in operator to subsequent events.
 *
 * Only the better-auth user id — no email, no name. The id is already the
 * subject of every audit-log row, so it adds no linkage the control plane did
 * not already hold, and it is what makes "who hit this error" answerable.
 */
export const identifyOperator = (userId: string, organizationId: string): void => {
    if (!initialized) {
        return;
    }

    posthogClient.identify(userId);
    // The organization is the unit of analysis for a B2B control plane — "which
    // tenants never open Traces", "does the empty Projects screen correlate
    // with churn" — and none of that is answerable from person-level events
    // alone. A PostHog group rather than an event property so the association
    // survives onto every subsequent event without each one carrying it, and so
    // it lines up with the server-side events, which are keyed on the same id.
    posthogClient.group("organization", organizationId);
};

/** Drop the identity and its persisted device id — called on sign-out, so the next operator on a shared machine is not attributed to the last one. */
export const resetOperator = (): void => {
    if (!initialized) {
        return;
    }

    posthogClient.reset(true);
};

/**
 * Record one product event.
 *
 * `properties` is deliberately typed to primitives: an object here is how a
 * whole tenant row ends up in PostHog by accident, which is the same leak
 * autocapture was turned off to prevent.
 */
export const captureEvent = (event: string, properties: Record<string, boolean | number | string> = {}): void => {
    if (!initialized) {
        return;
    }

    posthogClient.capture(event, properties);
};

export { UNMASK_ATTRIBUTE };
