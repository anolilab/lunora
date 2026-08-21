import type { ReactElement } from "react";
import { useState } from "react";

import { Input } from "../../components/ui/input";
import { useAssistantRpc } from "../../hooks/use-assistant-rpc";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import { cn } from "../../lib/utils";

/**
 * Describe a schedule in plain English, get the Cron Trigger expression.
 *
 * **It applies nothing, because there is nothing here to apply to.** Cron
 * triggers are the `cronJobs()` map compiled into the worker — the panel below is
 * read-only for exactly that reason — so the only honest output is an expression
 * the operator copies into `lunora/crons.ts`. That is still the step they were
 * doing by hand.
 *
 * What comes back has already passed the deployable 5-field grammar server-side,
 * so a schedule `wrangler deploy` would reject degrades to a message instead of
 * arriving as something to paste. Renders nothing when the assistant cannot run
 * here, on the same latch every other affordance uses.
 */
const CronScheduleAssistant = (): ReactElement | null => {
    const t = useT();
    // The root shard: the op reads no shard state at all — it is served here
    // rather than at the worker only because that is where its siblings live.
    const rpc = useAssistantRpc("");

    const [prompt, setPrompt] = useState("");
    const [cron, setCron] = useState<string | undefined>(undefined);
    const [copied, setCopied] = useState(false);

    if (rpc.unavailable) {
        return null;
    }

    const pending = rpc.pending("cron");
    const reason = rpc.reason("cron");

    const submit = (): void => {
        const text = prompt.trim();

        if (text === "") {
            return;
        }

        const draft = async (): Promise<void> => {
            const suggested = await rpc.suggestCron(text);

            setCopied(false);
            setCron(suggested);
        };

        fireAndForget(draft());
    };

    const copy = (): void => {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard; guarded by the "navigator" in globalThis check
        const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

        if (clipboard === undefined || cron === undefined) {
            return;
        }

        fireAndForget(clipboard.writeText(cron));
        setCopied(true);
    };

    return (
        <div className="flex flex-col gap-1.5" data-testid="cron-assistant">
            <div className="flex items-center gap-2">
                <Input
                    aria-label={t("Describe a schedule")}
                    className="h-7 flex-1 text-xs"
                    data-testid="cron-assistant-prompt"
                    disabled={pending}
                    onChange={(event) => {
                        setPrompt(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            submit();
                        }
                    }}
                    placeholder={t("Describe a schedule")}
                    value={prompt}
                />
                <button
                    className={cn(
                        "rounded-md border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                        pending && "opacity-60",
                    )}
                    data-testid="cron-assistant-generate"
                    disabled={pending || prompt.trim() === ""}
                    onClick={submit}
                    type="button"
                >
                    {pending ? t("Thinking…") : t("Suggest schedule")}
                </button>
            </div>

            {cron !== undefined && (
                <div className="flex items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums" data-testid="cron-assistant-result">
                        {cron}
                    </code>
                    <button
                        className="rounded-md border border-border px-2 py-0.5 text-[11px] outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                        data-testid="cron-assistant-copy"
                        onClick={copy}
                        type="button"
                    >
                        {copied ? t("Copied") : t("Copy")}
                    </button>
                    <span className="text-[11px] text-muted-foreground">{t("Add it to lunora/crons.ts — triggers are compiled into the worker.")}</span>
                </div>
            )}

            {reason !== undefined && (
                <p className="text-[11px] text-muted-foreground" data-testid="cron-assistant-reason" role="status">
                    {reason === "ai-error" ? t("The model could not be reached.") : t("The model did not return a schedule Cron Triggers accept.")}
                </p>
            )}
        </div>
    );
};

export default CronScheduleAssistant;
