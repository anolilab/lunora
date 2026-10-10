import type { KeyboardEvent, ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";

/**
 * The composer: one line of text and the send button beside it.
 *
 * Holds no state of its own — the draft lives in `AssistantPanel`, which owns the
 * send path and the seeded-draft effect, so every hook stays above the panel's
 * early return.
 */
const AssistantComposer = ({
    draft,
    onDraftChange,
    onSend,
    pending,
}: {
    readonly draft: string;
    readonly onDraftChange: (value: string) => void;
    readonly onSend: () => void;
    readonly pending: boolean;
}): ReactElement => {
    const t = useT();

    // Wrapped: passing `onSend` straight to onClick would hand it the click EVENT.
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            event.preventDefault();
            onSend();
        }
    };

    return (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <Input
                aria-label={t("Ask about your data")}
                data-testid="assistant-input"
                disabled={pending}
                onChange={(event) => {
                    onDraftChange(event.target.value);
                }}
                onKeyDown={onKeyDown}
                placeholder={t("Ask about your data")}
                value={draft}
            />
            <Button
                data-testid="assistant-send"
                disabled={pending || draft.trim() === ""}
                onClick={() => {
                    onSend();
                }}
                size="xs"
                type="button"
            >
                {pending ? t("Thinking…") : t("Send")}
            </Button>
        </div>
    );
};

export default AssistantComposer;
