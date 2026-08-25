import type { ReactElement } from "react";
import { useState } from "react";

import { Input } from "../../components/ui/input";
import type { AssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import { cn } from "../../lib/utils";
import assistantReasonMessage from "./assistant-reason";

/**
 * Natural-language prompt bar above the SQL editor.
 *
 * Renders nothing when the app has no `AI` binding — an affordance that can
 * never work is worse than no affordance. The generated statement lands in the
 * editor UNEXECUTED; the operator reads it and presses Run, exactly as with
 * anything they typed. It has already passed the same read-only gate the server
 * enforces before it gets here.
 */
const SqlAssistantBar = ({
    rpc,
    failed,
    onGenerated,
}: {
    /** The last failed run, enabling the repair affordance. */
    readonly failed?: { error: string; sql: string };
    readonly onGenerated: (sql: string) => void;
    readonly rpc: AssistantRpc;
}): ReactElement | null => {
    const t = useT();

    const [prompt, setPrompt] = useState("");

    if (rpc.unavailable) {
        return null;
    }

    // Only THIS surface's task — a chart inference running in the editor below
    // must not spin this button or print its error here.
    const pending = rpc.pending("sql");
    const reason = rpc.reason("sql");

    const submit = (repair: boolean): void => {
        const text = prompt.trim();

        if (text === "" && !repair) {
            return;
        }

        const apply = async (): Promise<void> => {
            const sql = await rpc.generate(text === "" ? "fix the failing statement" : text, repair ? failed : undefined);

            if (sql !== undefined) {
                onGenerated(sql);
            }
        };

        fireAndForget(apply());
    };

    return (
        <div className="flex flex-col gap-1 border-b border-border px-3 py-2" data-testid="sql-assistant">
            <div className="flex items-center gap-2">
                <Input
                    aria-label={t("Describe the query you want")}
                    className="h-7 flex-1 text-xs"
                    data-testid="sql-assistant-prompt"
                    disabled={pending}
                    onChange={(event) => {
                        setPrompt(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            submit(false);
                        }
                    }}
                    placeholder={t("Describe the query you want")}
                    value={prompt}
                />
                <button
                    className={cn(
                        "rounded-md border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                        pending && "opacity-60",
                    )}
                    data-testid="sql-assistant-generate"
                    disabled={pending || prompt.trim() === ""}
                    onClick={() => {
                        submit(false);
                    }}
                    type="button"
                >
                    {pending ? t("Thinking…") : t("Draft SQL")}
                </button>
                {/* The repair affordance is what makes drafting pay off — a first
                    draft is often one column name away from correct. */}
                {failed !== undefined && (
                    <button
                        className="rounded-md border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                        data-testid="sql-assistant-fix"
                        disabled={pending}
                        onClick={() => {
                            submit(true);
                        }}
                        type="button"
                    >
                        {t("Fix this")}
                    </button>
                )}
            </div>
            {reason !== undefined && (
                <p className="text-[11px] text-muted-foreground" data-testid="sql-assistant-reason" role="status">
                    {assistantReasonMessage(reason, t)}
                </p>
            )}
        </div>
    );
};
export default SqlAssistantBar;
