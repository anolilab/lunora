import type { ReactElement } from "react";
import { useState } from "react";

import BrandMark from "../components/brand-mark";
import { useTheme } from "../components/theme-provider";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import type { createStudioI18n } from "../i18n/i18n-context";
import { useT } from "../i18n/i18n-context";
import { StudioI18nProvider } from "../i18n/i18n-provider";
import STUDIO_ROOT_CLASS from "../lib/theme-constants";
import { cn } from "../lib/utils";

interface StudioLoginProps {
    /** The studio-scoped i18n instance (the app owns it; the login renders under the same provider). */
    readonly i18n: ReturnType<typeof createStudioI18n>;
    /** Called with the entered token when the operator connects. */
    readonly onSubmit: (token: string) => void;
}

/** The token-entry form. Lives under {@link StudioI18nProvider} so `useT` resolves the studio strings. */
const StudioLoginForm = ({ onSubmit }: { readonly onSubmit: (token: string) => void }): ReactElement => {
    const t = useT();
    const [value, setValue] = useState("");
    const trimmed = value.trim();

    // Structurally typed (not `React.FormEvent`, which the lint flags as
    // deprecated) — all we need off the submit event is `preventDefault`.
    const submit = (event: { preventDefault: () => void }): void => {
        event.preventDefault();

        if (trimmed !== "") {
            onSubmit(trimmed);
        }
    };

    return (
        <form
            className="flex w-full max-w-sm flex-col gap-5 rounded-xl border border-border bg-card p-7 shadow-lg"
            data-testid="lunora-studio-login"
            onSubmit={submit}
        >
            <div className="flex flex-col items-center gap-3 text-center">
                <div className="h-10 w-10 text-foreground">
                    <BrandMark />
                </div>
                <div className="flex flex-col gap-1">
                    <h1 className="text-base font-semibold text-foreground">{t("Connect to Lunora Studio")}</h1>
                    <p className="text-[13px] text-muted-foreground">{t("Enter your admin token to access the studio.")}</p>
                </div>
            </div>

            <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-foreground" htmlFor="lunora-studio-login-token">
                    {t("admin token")}
                </label>
                <Input
                    autoComplete="off"
                    autoFocus
                    data-testid="lunora-studio-login-token"
                    id="lunora-studio-login-token"
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                    placeholder="LUNORA_ADMIN_TOKEN"
                    type="password"
                    value={value}
                />
                <p className="text-[11px] text-muted-foreground">
                    {t("From your worker's LUNORA_ADMIN_TOKEN — your project's .dev.vars in dev, or a deployment secret in production.")}
                </p>
            </div>

            <Button data-testid="lunora-studio-login-submit" disabled={trimmed === ""} type="submit">
                {t("Connect")}
            </Button>
        </form>
    );
};

/**
 * Full-page token gate. Shown by the studio app whenever no admin token is
 * present (none injected by the dev host, none persisted from a prior session),
 * so every studio page sits behind a token entry. Renders its own theme-scoped
 * root (mirroring `StudioShell`) so it's styled + localized without the rest of
 * the app mounting.
 */
const StudioLogin = ({ i18n, onSubmit }: StudioLoginProps): ReactElement => {
    const { resolvedTheme } = useTheme();

    return (
        <div
            className={cn(
                STUDIO_ROOT_CLASS,
                resolvedTheme === "dark" && "dark",
                "flex h-dvh items-center justify-center bg-sidebar p-6 text-sm text-foreground",
            )}
            data-testid="lunora-studio-login-root"
        >
            <StudioI18nProvider i18n={i18n}>
                <StudioLoginForm onSubmit={onSubmit} />
            </StudioI18nProvider>
        </div>
    );
};

export default StudioLogin;
