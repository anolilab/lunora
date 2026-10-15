import type { ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";

/** The panel's title strip: what it is, the answers-are-suggestions reminder, and close. */
const AssistantHeader = ({ onClose }: { readonly onClose: () => void }): ReactElement => {
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

export default AssistantHeader;
