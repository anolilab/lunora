import type { ReactElement } from "react";

import { useT } from "../../i18n/i18n-context";

/** Starter questions, shown only while the transcript is empty. */
const AssistantSuggestions = ({
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

export default AssistantSuggestions;
