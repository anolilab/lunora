import type { ReactElement } from "react";

import type { SessionTurn } from "../../components/assistant-provider";
import { useT } from "../../i18n/i18n-context";
import type { AiOptInLevel } from "../../lib/admin";

/**
 * What one turn actually did, listed rather than summarised.
 *
 * The panel used to print a single line — "Answered after reading your data" —
 * for the whole session, which said an answer touched the database but not what
 * it read or whether anything was refused. A turn that ran three statements and
 * one that ran none looked identical, and a refusal looked like nothing at all.
 */
const ToolCalls = ({ level, turn }: { readonly level: AiOptInLevel | undefined; readonly turn: SessionTurn }): ReactElement | null => {
    const t = useT();
    const calls = turn.toolCalls ?? [];

    if (calls.length === 0 && turn.partial !== true) {
        return null;
    }

    return (
        <ul className="flex flex-col gap-0.5 border-s border-border ps-2 text-[11px] text-muted-foreground" data-testid="assistant-tool-calls">
            {calls.map((call, at) => (
                <li
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- the calls of one immutable turn, in order
                    key={`${String(at)}:${call.name ?? "?"}`}
                >
                    <span className="font-mono">{call.name ?? t("(no such tool)")}</span>
                    {call.sql === undefined ? null : <span className="ms-1 font-mono opacity-80">{call.sql}</span>}
                    {call.refused === undefined ? null : <span className="ms-1 text-destructive">{t("refused")}</span>}
                    {/* A level refusal is the ONE refusal the operator can act on, and
                        until now its reason reached only the model — the panel printed
                        the bare word "refused", so a tool the deployment had simply not
                        opted into looked identical to a malformed request. `needs` is
                        structured for exactly this: say which tier it wanted, where the
                        deployment sits, and which var moves it. */}
                    {call.needs === undefined ? null : (
                        <span className="block text-muted-foreground" data-testid="assistant-tool-needs">
                            {t("Needs the {needs} data-sharing level; this deployment is set to {level}. Change LUNORA_AI_OPT_IN in wrangler.jsonc.", {
                                level: level ?? t("a lower level"),
                                needs: call.needs,
                            })}
                        </span>
                    )}
                </li>
            ))}
            {turn.partial === true && <li data-testid="assistant-turn-partial">{t("Stopped early — this answer is incomplete.")}</li>}
        </ul>
    );
};

export default ToolCalls;
