import type { ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";
import type { GenerateSqlDegradedReason } from "../../lib/admin";

/** The panel's title strip: what it is, the answers-are-suggestions reminder, and close. */
export const AssistantHeader = ({ onClose }: { readonly onClose: () => void }): ReactElement => {
    const t = useT();

    return (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{t("Assistant")}</span>
            <span className="text-[11px] text-muted-foreground">{t("Answers are suggestions — nothing runs until you insert and run it.")}</span>
            <Button
                aria-label={t("Close assistant")}
                className="ms-auto"
                data-testid="assistant-close"
                onClick={onClose}
                size="xs"
                type="button"
                variant="ghost"
            >
                ×
            </Button>
        </div>
    );
};

/**
 * The two notices the transcript can carry: the context budget dropped older
 * turns, or the last turn failed and its reason is shown from the ops' own status
 * (a failure never looks like a reply).
 */
export const AssistantStatus = ({
    reason,
    truncated,
}: {
    readonly reason: GenerateSqlDegradedReason | undefined;
    readonly truncated: boolean;
}): ReactElement => {
    const t = useT();

    return (
        <>
            {truncated && (
                <p className="px-3 py-1 text-[11px] text-muted-foreground" data-testid="assistant-truncated">
                    {t("Older turns were dropped to fit the context budget.")}
                </p>
            )}

            {reason !== undefined && (
                <p className="px-3 py-1 text-[11px] text-destructive" data-testid="assistant-error">
                    {reason === "empty-response" ? t("The model returned nothing usable.") : t("The model could not be reached.")}
                </p>
            )}
        </>
    );
};

/** Starter questions, shown only while the transcript is empty. */
export const AssistantSuggestions = ({
    onPick,
    suggestions,
}: {
    readonly onPick: (suggestion: string) => void;
    readonly suggestions: ReadonlyArray<string>;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-1 px-3 py-2" data-testid="assistant-suggestions">
            <span className="text-[11px] text-muted-foreground">{t("Try asking")}</span>
            {suggestions.map((suggestion) => (
                <button
                    className="self-start rounded-md border border-border px-2 py-1 text-start text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                    data-testid="assistant-suggestion"
                    key={suggestion}
                    onClick={() => {
                        onPick(suggestion);
                    }}
                    type="button"
                >
                    {suggestion}
                </button>
            ))}
        </div>
    );
};
