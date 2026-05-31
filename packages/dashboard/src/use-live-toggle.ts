import { useCallback, useState } from "react";

export interface LiveToggleState {
    /** Whether the live WebSocket channel is currently enabled. */
    readonly live: boolean;
    /** The latest live-subscription rejection message, or `null` when healthy. */
    readonly liveError: null | string;
    /** Set/clear the live error (pass to `useLiveAdmin`'s `onError`; call with `null` on a successful push). */
    readonly setLiveError: (message: null | string) => void;
    /** Flip the toggle, clearing any stale error so the banner doesn't linger. */
    readonly toggle: () => void;
}

/**
 * Shared state for a panel's **Live** toggle: the on/off flag plus the
 * "Live unavailable" error a rejected admin subscription surfaces. Centralised
 * so every panel's toggle behaves identically (clears the error on toggle; the
 * panel clears it again on the next successful push).
 */
export function useLiveToggle(): LiveToggleState {
    const [live, setLive] = useState<boolean>(false);
    const [liveError, setLiveError] = useState<null | string>(null);

    const toggle = useCallback((): void => {
        setLiveError(null);
        setLive((on) => !on);
    }, []);

    return { live, liveError, setLiveError, toggle };
}
