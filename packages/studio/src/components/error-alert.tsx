import { flattenHint } from "@lunora/errors";
import type { ReactElement } from "react";

import { errorDocumentationUrl, errorHint, errorMessage } from "../lib/internal";
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
    const hint = errorHint(error);
    const documentationUrl = errorDocumentationUrl(error);

    return (
        <Alert className={className} testId={testId} variant="destructive">
            <p className="font-medium">{errorMessage(error)}</p>
            {hint === undefined ? null : <p className="mt-1 whitespace-pre-wrap text-xs opacity-90">{flattenHint(hint)}</p>}
            {documentationUrl === undefined ? null : (
                <a className="mt-1 inline-block text-xs underline" href={documentationUrl} rel="noreferrer" target="_blank">
                    Learn more
                </a>
            )}
        </Alert>
    );
};
