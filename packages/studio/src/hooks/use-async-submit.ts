import { useState } from "react";

import { errorMessage, fireAndForget } from "../lib/internal";

/**
 * Track the busy/error lifecycle of a modal's async submit. `run` flips `busy`,
 * clears the prior error, awaits the action, swallows any rejection into `error`
 * (so the modal stays open and shows it), and always clears `busy` — the action
 * itself closes the modal only on success. Shared by every studio dialog that
 * submits a mutation (the auth org dialogs, the create-user dialog, …).
 */
export const useAsyncSubmit = (): { busy: boolean; error: null | string; run: (action: () => Promise<void>) => void } => {
    const [busy, setBusy] = useState<boolean>(false);
    // eslint-disable-next-line unicorn/no-null -- error sentinel; consumers gate the message on `error !== null`
    const [error, setError] = useState<null | string>(null);

    const run = (action: () => Promise<void>): void => {
        fireAndForget(
            (async (): Promise<void> => {
                setBusy(true);
                // eslint-disable-next-line unicorn/no-null -- clear the prior error before re-running (matches the `null` sentinel)
                setError(null);

                try {
                    await action();
                } catch (error_) {
                    setError(errorMessage(error_));
                }

                setBusy(false);
            })(),
        );
    };

    return { busy, error, run };
};
