/**
 * The resend cooldown shared by every flow that sends something the user can
 * ask for again (a magic link, a reset email, a verification link, a one-time
 * code). Each send is a mail or an SMS someone pays for and a provider rate
 * limits, and an impatient second send can invalidate the code the first one
 * delivered — so a successful send sets `resendAvailableAt` and the controller
 * refuses another until then.
 *
 * The countdown arithmetic lives here and only here; each port's submit button
 * owns just the one-second tick and its cleanup, through {@link watchCooldown},
 * so the six ports cannot drift on what the countdown shows.
 */
import type { Localization } from "./localization";

const RESEND_COOLDOWN_MS = 30_000;

/** Whether a send is still refused. */
const cooldownActive = (availableAt: number | undefined): boolean => availableAt !== undefined && Date.now() < availableAt;

/** Whole seconds until `availableAt`, rounded up; `0` once it has passed. */
const secondsUntil = (availableAt: number | undefined): number => (availableAt === undefined ? 0 : Math.max(0, Math.ceil((availableAt - Date.now()) / 1000)));

/**
 * Report the seconds left now, then once a second until they reach zero.
 * Returns the stop for the port's own cleanup (unmount, or a new `availableAt`).
 */
const watchCooldown = (availableAt: number | undefined, onTick: (seconds: number) => void): (() => void) => {
    const tick = (): number => {
        const seconds = secondsUntil(availableAt);

        onTick(seconds);

        return seconds;
    };

    if (tick() === 0) {
        return () => undefined;
    }

    const timer = setInterval(() => {
        if (tick() === 0) {
            clearInterval(timer);
        }
    }, 1000);

    return () => {
        clearInterval(timer);
    };
};

/** The countdown line a cooling-down button shows. */
const cooldownLabel = (localization: Localization, seconds: number): string => localization.resendAvailableIn.replace("{seconds}", String(seconds));

export { cooldownActive, cooldownLabel, RESEND_COOLDOWN_MS, secondsUntil, watchCooldown };
