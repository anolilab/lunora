import posthogClient from "posthog-js";

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

/** Whether `posthogClient.init` actually ran. Every helper checks it: calling into an uninitialized client touches persistence `init` is supposed to create. */
let initialized = false;

if (!import.meta.env.SSR && token && host) {
    posthogClient.init(token, {
        api_host: host,
        // Off, and the reason is the whole point of this file — see the module
        // docblock. Manual events only.
        autocapture: false,
        // Unhandled errors and rejections. The message and stack are the app's
        // own; no DOM text rides along.
        capture_exceptions: true,
        // The router owns navigation, so PostHog's own listener would miss
        // client-side transitions and double-count the first load.
        capture_pageview: false,
        // `init` runs before hydration; the SDK's default script target is
        // `body`, and a node appended there that React did not render is a
        // hydration mismatch.
        external_scripts_inject_target: "head",
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
export const identifyOperator = (userId: string): void => {
    if (!initialized) {
        return;
    }

    posthogClient.identify(userId);
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
