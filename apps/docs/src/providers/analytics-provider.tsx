import { useConsentManager } from "@c15t/react";
import type { FC, PropsWithChildren } from "react";
import { useEffect } from "react";

import { applyMeasurementConsent } from "@/lib/posthog";

/**
 * Syncs PostHog to the c15t consent state.
 *
 * The client itself is initialized once, at module scope in `lib/posthog`,
 * because the root route imports that module for its side effect before this
 * component ever renders. This provider therefore only carries the *decision*
 * across — it must not initialize PostHog itself: posthog-js treats a second
 * `init` as a no-op, so the cookieless/opt-out defaults set in a component
 * would never be applied and consent would have no effect on what is captured.
 */
const AnalyticsProvider: FC<PropsWithChildren> = ({ children }) => {
    const { consents, hasConsented } = useConsentManager();

    const measurementConsent = hasConsented() ? consents.measurement : undefined;

    useEffect(() => {
        // No explicit choice yet — the init defaults (no capture, no device
        // storage) already describe what should happen until there is one.
        if (measurementConsent === undefined) {
            return;
        }

        applyMeasurementConsent(measurementConsent);
    }, [measurementConsent]);

    return children;
};

export default AnalyticsProvider;
