import type { AuthCapabilities } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { Badge } from "../../components/ui/badge";
import type { MessageId } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import { errorMessage, fireAndForget } from "../../lib/internal";

/**
 * The capability flags surfaced as rows, paired with a human label key. Order is
 * fixed so the grid reads the same on every render. The labels are passed through
 * `t()` at render time (the values here are the translation keys).
 */
const CAPABILITY_ROWS: ReadonlyArray<{ key: keyof AuthCapabilities; label: MessageId }> = [
    { key: "accounts", label: "Accounts" },
    { key: "admin", label: "Admin" },
    { key: "organization", label: "Organizations" },
    { key: "passkey", label: "Passkeys" },
    { key: "twoFactor", label: "Two-factor" },
];

/**
 * Read-only view of the auth deployment's enabled capabilities/plugins. The
 * capability set is fixed per deployment (which better-auth plugins are wired in
 * the server's auth setup), so this panel only reads it — nothing here is
 * editable. OAuth providers, email templates, and rate limits are configured at
 * deploy time and aren't surfaced for editing; the note points at the Mail tab
 * for email output.
 */
// eslint-disable-next-line import/prefer-default-export -- studio panels are named exports, mounted by name in studio.tsx
export const AuthConfigPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();

    const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [loading, setLoading] = useState<boolean>(true);

    useEffect(() => {
        const token = { cancelled: false };

        fireAndForget(
            (async (): Promise<void> => {
                try {
                    const result = await client.getAuthCapabilities();

                    if (!token.cancelled) {
                        setCapabilities(result);
                        setError(null);
                    }
                } catch (error_) {
                    if (!token.cancelled) {
                        setError(errorMessage(error_));
                    }
                } finally {
                    if (!token.cancelled) {
                        setLoading(false);
                    }
                }
            })(),
        );

        return () => {
            token.cancelled = true;
        };
    }, [client]);

    return (
        <div className="flex flex-col gap-4" data-testid="auth-config">
            <section className="rounded-md border border-border p-3">
                <h3 className="mb-2 text-sm font-semibold">{t("Enabled capabilities")}</h3>

                {error !== null && (
                    <p className="text-sm text-destructive" data-testid="auth-config-error" role="alert">
                        {error}
                    </p>
                )}

                {error === null && loading && (
                    <p className="text-sm text-muted-foreground" data-testid="auth-config-loading">
                        {t("Loading auth configuration…")}
                    </p>
                )}

                {error === null && !loading && capabilities !== null && (
                    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {CAPABILITY_ROWS.map((row) => {
                            const enabled = capabilities[row.key];

                            return (
                                <li
                                    className="flex items-center justify-between gap-2 rounded-md border border-border p-2"
                                    data-testid={`auth-config-cap-${row.key}`}
                                    key={row.key}
                                >
                                    <span className="text-sm">{t(row.label)}</span>
                                    <Badge variant={enabled ? "default" : "outline"}>{enabled ? t("Enabled") : t("Disabled")}</Badge>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground" data-testid="auth-config-note">
                {t(
                    "OAuth providers, email templates, and rate limits are configured at deploy time in the better-auth setup and aren't editable here. See the Mail tab for email output.",
                )}
            </p>
        </div>
    );
};
