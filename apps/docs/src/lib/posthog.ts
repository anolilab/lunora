import posthogClient from "posthog-js";

const token = typeof import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN === "string" ? import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN : undefined;
const host = typeof import.meta.env.VITE_PUBLIC_POSTHOG_HOST === "string" ? import.meta.env.VITE_PUBLIC_POSTHOG_HOST : undefined;

if (!import.meta.env.SSR) {
    if (token && host) {
        posthogClient.init(token, {
            // First-party path, proxied to PostHog by `public/_redirects` in
            // production and by `server.proxy` in `vite.config.ts` during dev.
            // Both must carry the rule or captures are silently dropped.
            api_host: "/pr/posthog",
            capture_exceptions: true,
            // `init` runs from a root-route side effect, before hydration. The
            // SDK's default target is `body`, and a script appended there ahead
            // of hydration is a DOM node React did not render — a mismatch.
            // `head` is outside the hydration root. (PostHog's own `defaults`
            // of "2026-01-30" flips this for the same reason; set explicitly so
            // it does not depend on a defaults date we have not opted into.)
            external_scripts_inject_target: "head",
            // Ingestion goes through the proxy above; `host` only drives the
            // "view in PostHog" links the toolbar renders.
            ui_host: host,
        });
    } else if (import.meta.env.DEV) {
        // Warn, don't throw. `.env` is gitignored, so a fresh clone has neither
        // variable — throwing here took the whole docs dev server down for any
        // contributor who just wants to edit a page.
        const missing = [token ? undefined : "VITE_PUBLIC_POSTHOG_PROJECT_TOKEN", host ? undefined : "VITE_PUBLIC_POSTHOG_HOST"].filter(Boolean).join(" and ");

        // eslint-disable-next-line no-console -- dev-only diagnostic; the console is the only channel available at module scope before the app mounts
        console.warn(`[posthog] ${missing} not configured — analytics is disabled for this dev session. Set it in apps/docs/.env to enable capture.`);
    }
}

export { default } from "posthog-js";
