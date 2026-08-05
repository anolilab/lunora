import type { AuthCapabilities, AuthConfigInfo } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ReactElement, ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { useClientQuery } from "../../hooks/use-admin-query";
import type { MessageId } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";

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

/** Render a duration (in seconds) as the largest evenly-dividing unit, or an em-dash when unset. */
const formatDuration = (seconds: number | undefined): string => {
    if (seconds === undefined) {
        return "—";
    }

    const units: ReadonlyArray<[number, string]> = [
        [86_400, "d"],
        [3600, "h"],
        [60, "m"],
    ];

    for (const [size, suffix] of units) {
        if (seconds >= size && seconds % size === 0) {
            return `${String(seconds / size)}${suffix}`;
        }
    }

    return `${String(seconds)}s`;
};

/** A titled card wrapping one config section. */
const ConfigCard = ({ children, heading, testId }: { children: ReactNode; heading: string; testId: string }): ReactElement => (
    <Card className="gap-0 py-0" data-testid={testId}>
        <header className="border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{heading}</span>
        </header>
        <CardContent className="p-3">{children}</CardContent>
    </Card>
);

/** A label / value definition row. */
const KeyValue = ({ label, value }: { label: string; value: ReactNode }): ReactElement => (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-2 shadow-xs">
        <span className="text-sm">{label}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{value}</span>
    </div>
);

/**
 * Read-only overview of the auth deployment's configuration — which better-auth
 * plugins are wired, the sign-in methods (email/password + social providers),
 * the organization sub-features (teams / custom roles), the session policy, the
 * rate-limit policy, and the plugin-derived user fields. It's a single
 * `getAuthConfig()` read; nothing here is editable (the config is fixed per
 * deployment in the server's better-auth setup), so this panel only reflects it.
 * The note points at the Mail tab for email output.
 */
const AuthConfigPanel = (): ReactElement => {
    const client = useLunora();
    const t = useT();

    // The config is HTTP-only (no admin-RPC path), so it's a one-shot
    // `useClientQuery` over `client.getAuthConfig`. `data === undefined`
    // distinguishes the initial load from a resolved result.
    const { data: config, error } = useClientQuery<AuthConfigInfo>(["lunora-auth-config"], () => client.getAuthConfig());

    const statusBadge = (on: boolean): ReactElement => <Badge variant={on ? "success" : "outline"}>{on ? t("Enabled") : t("Disabled")}</Badge>;

    return (
        <div className="flex flex-col gap-4" data-testid="auth-config">
            {error !== null && (
                <p className="px-4 py-8 text-center text-sm text-destructive" data-testid="auth-config-error" role="alert">
                    {error}
                </p>
            )}

            {error === null && config === undefined && (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="auth-config-loading">
                    {t("Loading auth configuration…")}
                </p>
            )}

            {error === null && config !== undefined && (
                <>
                    <ConfigCard heading={t("Enabled capabilities")} testId="auth-config-capabilities">
                        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {CAPABILITY_ROWS.map((row) => {
                                const enabled = config.capabilities[row.key];

                                return (
                                    <li
                                        className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-2 shadow-xs"
                                        data-testid={`auth-config-cap-${row.key}`}
                                        key={row.key}
                                    >
                                        <span className="text-sm">{t(row.label)}</span>
                                        {statusBadge(enabled)}
                                    </li>
                                );
                            })}
                        </ul>
                    </ConfigCard>

                    <ConfigCard heading={t("Plugins")} testId="auth-config-plugins">
                        {config.plugins.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("No plugins enabled.")}</p>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                {config.plugins.map((plugin) => (
                                    <Badge data-testid={`auth-config-plugin-${plugin}`} key={plugin} variant="outline">
                                        {plugin}
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </ConfigCard>

                    <ConfigCard heading={t("Sign-in methods")} testId="auth-config-signin">
                        <div className="flex flex-col gap-2">
                            <KeyValue label={t("Email & password")} value={statusBadge(config.emailAndPassword)} />
                            <KeyValue
                                label={t("Social providers")}
                                value={
                                    config.socialProviders.length === 0 ? (
                                        t("None")
                                    ) : (
                                        <span className="flex flex-wrap justify-end gap-1">
                                            {config.socialProviders.map((provider) => (
                                                <Badge data-testid={`auth-config-provider-${provider}`} key={provider} variant="outline">
                                                    {provider}
                                                </Badge>
                                            ))}
                                        </span>
                                    )
                                }
                            />
                        </div>
                    </ConfigCard>

                    {config.organization.enabled && (
                        <ConfigCard heading={t("Organizations")} testId="auth-config-org">
                            <div className="flex flex-col gap-2">
                                <KeyValue label={t("Teams")} value={statusBadge(config.organization.teams)} />
                                <KeyValue label={t("Custom roles")} value={statusBadge(config.organization.roles)} />
                            </div>
                        </ConfigCard>
                    )}

                    <ConfigCard heading={t("Session policy")} testId="auth-config-session">
                        <div className="flex flex-col gap-2">
                            <KeyValue label={t("Expires in")} value={formatDuration(config.session.expiresIn)} />
                            <KeyValue label={t("Refresh after")} value={formatDuration(config.session.updateAge)} />
                            <KeyValue label={t("Fresh window")} value={formatDuration(config.session.freshAge)} />
                            <KeyValue label={t("Cookie cache")} value={statusBadge(config.session.cookieCache === true)} />
                        </div>
                    </ConfigCard>

                    <ConfigCard heading={t("Rate limit")} testId="auth-config-ratelimit">
                        <div className="flex flex-col gap-2">
                            <KeyValue label={t("Status")} value={statusBadge(config.rateLimit.enabled)} />
                            {config.rateLimit.enabled && (
                                <>
                                    <KeyValue label={t("Max requests")} value={config.rateLimit.max ?? "—"} />
                                    <KeyValue label={t("Window")} value={formatDuration(config.rateLimit.window)} />
                                </>
                            )}
                        </div>
                    </ConfigCard>

                    {config.userFields.length > 0 && (
                        <ConfigCard heading={t("Plugin user fields")} testId="auth-config-user-fields">
                            <ul className="flex flex-col gap-2">
                                {config.userFields.map((field) => (
                                    <li
                                        className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card p-2 shadow-xs"
                                        data-testid={`auth-config-user-field-${field.name}`}
                                        key={field.name}
                                    >
                                        <span className="flex flex-col">
                                            <span className="font-mono text-xs">{field.name}</span>
                                            {field.plugin !== undefined && <span className="text-[11px] text-muted-foreground">{field.plugin}</span>}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Badge variant="outline">{field.type}</Badge>
                                            {field.required && <Badge variant="secondary">{t("required")}</Badge>}
                                            {field.unique && <Badge variant="secondary">{t("unique")}</Badge>}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </ConfigCard>
                    )}

                    <Card className="gap-0 py-0">
                        <p className="px-4 py-3 text-xs text-muted-foreground" data-testid="auth-config-note">
                            {t(
                                "OAuth providers, email templates, and rate limits are configured at deploy time in the better-auth setup and aren't editable here. See the Mail tab for email output.",
                            )}
                        </p>
                    </Card>
                </>
            )}
        </div>
    );
};
export default AuthConfigPanel;
