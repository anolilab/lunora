import type { ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";
import type { ChatPendingApproval } from "../../lib/admin";

/**
 * The operator's gate on a read the turn stopped at.
 *
 * The engine returns the statement instead of running it, so this is where a row
 * value is first disclosed to a model — and the whole point is that the operator
 * sees the exact statement first. It is shown verbatim, unrendered: this is the
 * one piece of model output the operator is being asked to judge, so it must not
 * pass through a markdown renderer that could style it into something else.
 *
 * Both answers start a follow-up turn. Deny is not a local dismissal — the model
 * is told it was declined, so it answers from what it already has rather than
 * silently waiting for a result that will never arrive.
 */
const ApprovalCard = ({
    approval,
    onDecide,
}: {
    readonly approval: ChatPendingApproval;
    readonly onDecide: (allow: boolean, ticket: string) => void;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 p-2" data-testid="assistant-approval">
            <span className="text-[11px] text-muted-foreground">
                {t("The assistant wants to read rows before answering. Nothing runs until you allow it.")}
            </span>
            <pre className="overflow-x-auto rounded bg-background p-1.5 font-mono text-[11px]" data-testid="assistant-approval-sql">
                {approval.sql}
            </pre>
            <div className="flex gap-2">
                <Button
                    data-testid="assistant-approval-allow"
                    onClick={() => {
                        onDecide(true, approval.ticket);
                    }}
                    size="xs"
                    type="button"
                >
                    {t("Allow")}
                </Button>
                <Button
                    data-testid="assistant-approval-deny"
                    onClick={() => {
                        onDecide(false, approval.ticket);
                    }}
                    size="xs"
                    type="button"
                    variant="secondary"
                >
                    {t("Deny")}
                </Button>
            </div>
        </div>
    );
};

export default ApprovalCard;
