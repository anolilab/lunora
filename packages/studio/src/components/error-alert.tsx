import { flattenHint } from "@lunora/errors";
import type { ReactElement } from "react";

import { useT } from "../i18n/i18n-context";
import { errorDocumentationUrl, errorHint, errorMessage } from "../lib/internal";
import { operationSeqOf } from "../lib/recording-client";
import { useOperationConsole } from "./operation-console-provider";
import { Alert } from "./ui/alert";

interface ErrorAlertProps {
    /** Extra classes merged onto the container (layout only). */
    readonly className?: string;
    /** The thrown value (a `LunoraClientError` carries `hint`/`docsUrl`). */
    readonly error: unknown;
    readonly testId?: string;
}

/**
 * A destructive callout that renders a failed admin/RPC call: the error message
 * plus, when the error carries them, the central catalog's actionable hint (how
 * to fix it) and a documentation link. Replaces the bare inline role=alert
 * message paragraphs so the studio surfaces the same fix the CLI and error
 * overlay show.
 */
export const ErrorAlert = ({ className, error, testId }: ErrorAlertProps): ReactElement => {
    const t = useT();
    // `undefined` when no console is mounted above this tree (a host embedding a
    // single panel, or a standalone render in a test). The affordance is then not
    // rendered at all — a button that silently does nothing is worse than none.
    const operationConsole = useOperationConsole();
    const hint = errorHint(error);
    const documentationUrl = errorDocumentationUrl(error);
    // `recordedCall` tags a rejection with its operation-tape entry, so this
    // callout can point at the exact call that produced it rather than making the
    // operator hunt. Untagged errors (thrown outside an admin RPC) fall back to
    // the errors-only view.
    const seq = operationSeqOf(error);

    const showInConsole = (): void => {
        operationConsole?.openConsole({ errorsOnly: true, seq });
    };

    return (
        <Alert className={className} testId={testId} variant="destructive">
            <p className="font-medium">{errorMessage(error)}</p>
            {hint === undefined ? null : <p className="mt-1 whitespace-pre-wrap text-xs opacity-90">{flattenHint(hint)}</p>}
            {documentationUrl === undefined ? null : (
                <a
                    aria-label="View documentation for this error"
                    className="mt-1 inline-block text-xs underline"
                    href={documentationUrl}
                    rel="noreferrer"
                    target="_blank"
                >
                    View error docs
                </a>
            )}
            {operationConsole === undefined ? null : (
                <button
                    className="mt-1 block text-xs underline outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="error-show-in-console"
                    onClick={showInConsole}
                    type="button"
                >
                    {t("Show in console")}
                </button>
            )}
        </Alert>
    );
};
