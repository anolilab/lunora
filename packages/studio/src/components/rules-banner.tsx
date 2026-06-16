import type { ReactElement } from "react";
import { useCallback, useState } from "react";

import { useT } from "../i18n/i18n-context";

/** `localStorage` key remembering that the developer dismissed the rules banner. */
const RULES_BANNER_DISMISSED_KEY = "lunora.studio.rulesBannerDismissed";

/** Read the persisted "rules banner dismissed" flag, tolerating storage being unavailable. */
const readBannerDismissed = (): boolean => {
    try {
        return globalThis.localStorage.getItem(RULES_BANNER_DISMISSED_KEY) === "1";
    } catch {
        return false;
    }
};

/** Persist the "rules banner dismissed" flag, swallowing storage failures (private mode / disabled). */
const writeBannerDismissed = (): void => {
    try {
        globalThis.localStorage.setItem(RULES_BANNER_DISMISSED_KEY, "1");
    } catch {
        // ignore — dismissal just won't survive a reload
    }
};

/**
 * A one-time nudge shown when the project's Lunora agent skills ("rules") aren't
 * installed. Renders at the top of the panel area; dismissal is persisted so it
 * stays gone across reloads. Reads lazily and tolerates storage being unavailable
 * (private mode / embeddings).
 */
const RulesBanner = (): ReactElement | null => {
    const t = useT();
    const [dismissed, setDismissed] = useState<boolean>(() => readBannerDismissed());

    const dismiss = useCallback((): void => {
        setDismissed(true);
        writeBannerDismissed();
    }, []);

    if (dismissed) {
        return null;
    }

    return (
        <div
            className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-6 py-2 text-[12px] text-foreground"
            data-testid="dash-app-rules-banner"
            role="note"
        >
            <span aria-hidden="true" className="text-warning">
                ⚠
            </span>
            <span>
                {t("Lunora AI rules aren't installed.")} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">lunora rules install</code>{" "}
                {t("lets your coding agent use Lunora correctly.")}
            </span>
            <button
                aria-label={t("Dismiss")}
                className="ms-auto flex size-5 items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
                data-testid="dash-app-rules-banner-dismiss"
                onClick={dismiss}
                type="button"
            >
                <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={1.8} viewBox="0 0 24 24">
                    <path d="M18 6 6 18M6 6l12 12" />
                </svg>
            </button>
        </div>
    );
};

export default RulesBanner;
