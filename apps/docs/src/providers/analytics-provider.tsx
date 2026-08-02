import { useConsentManager } from "@c15t/react";
// eslint-disable-next-line import/no-named-as-default
import posthog from "posthog-js";
import type { FC, PropsWithChildren } from "react";
import { useEffect } from "react";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_API_KEY as string | undefined;
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://eu.i.posthog.com";

const isEnabled = Boolean(POSTHOG_KEY) && !import.meta.env.DEV;

let initialized = false;

/**
 * PostHog in cookieless "on_reject" mode, synced to the c15t consent state.
 *
 * Pre-consent and after "Reject", PostHog stores nothing on the device — users
 * are counted via PostHog's server-side daily-salted hash instead (requires
 * "Cookieless server hash mode" enabled in the PostHog project settings, or
 * those events are dropped). After "Accept", normal cookie/localStorage
 * persistence with full session continuity. Init happens in an effect, so it
 * only ever runs client-side.
 */
const AnalyticsProvider: FC<PropsWithChildren> = ({ children }) => {
    const { consents, hasConsented } = useConsentManager();

    const measurementConsent = hasConsented() ? consents.measurement : undefined;

    useEffect(() => {
        if (!isEnabled) {
            return;
        }

        if (!initialized) {
            initialized = true;

            posthog.init(POSTHOG_KEY as string, {
                api_host: POSTHOG_HOST,
                cookieless_mode: "on_reject",
                defaults: "2026-06-25",
                // No storage before an explicit choice — pending consent behaves
                // like "rejected" (cookieless hash counting) until c15t says otherwise.
                opt_out_capturing_by_default: true,
                opt_out_persistence_by_default: true,
            });
        }

        if (measurementConsent === undefined) {
            return;
        }

        if (measurementConsent) {
            posthog.opt_in_capturing();
        } else {
            // Withdrawal must also erase what the accept path persisted
            // (distinct_id, device_id) — opt-out alone only stops capture.
            if (posthog.has_opted_in_capturing()) {
                posthog.reset(true);
            }

            posthog.opt_out_capturing();
        }
    }, [measurementConsent]);

    return children;
};

export default AnalyticsProvider;
