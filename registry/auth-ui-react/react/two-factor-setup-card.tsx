"use client";

import type { ReactElement } from "react";

import { createAccountsController } from "../core/accounts";
import { isFlowEnabled } from "../core/flow-gate";
import { createTwoFactorSetupController, totpSecret } from "../core/two-factor-setup";
import { onSubmit } from "./on-submit";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const TwoFactorSetupCard = (): ReactElement | null => {
    // Enrolment needs the account's password, which an OAuth-only user does not
    // have. A `credential` row in the linked accounts is what says they do.
    const [accounts] = useController(createAccountsController);
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = useController(createTwoFactorSetupController);
    const pending = state.status === "submitting";

    if (!isFlowEnabled(context, "twoFactor", "TwoFactorSetupCard")) {
        return null;
    }

    /*
     * An OAuth-only account has no password, and enrolment requires one. The
     * card stays visible and explains that, rather than vanishing: a security
     * setting that is simply absent reads as "this app doesn't support 2FA",
     * which sends people looking for a setting that is right there.
     *
     * Only a *successful* read that found no credential row counts. While it is
     * loading, or if it failed, the card behaves as before — same rule as the
     * flow gate: don't hide something you cannot reason about.
     */
    const knowsAccounts = !accounts.loading && accounts.error === undefined && accounts.status === "success";
    const missingPassword = knowsAccounts && !accounts.items.some((account) => account.providerId === "credential");

    if (missingPassword) {
        return (
            <AuthCard title={t.twoFactorSetup}>
                <p className="lunora-auth-note">{t.twoFactorNeedsPassword}</p>
            </AuthCard>
        );
    }

    if (state.step === "enabled") {
        return (
            <AuthCard title={t.twoFactorSetup}>
                <FormBanner error={state.error} success={t.twoFactorEnabled} />
                <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.disable)}>
                    <Field
                        autoComplete="current-password"
                        field={state.password}
                        label={t.passwordLabel}
                        name="password"
                        onBlur={() => undefined}
                        onChange={actions.setPassword}
                        type="password"
                    />
                    <SubmitButton pending={pending}>{t.twoFactorDisable}</SubmitButton>
                </form>
            </AuthCard>
        );
    }

    if (state.step === "verify") {
        return (
            <AuthCard description={t.twoFactorScan} title={t.twoFactorSetup}>
                <FormBanner error={state.error} />
                {/*
                 * The setup key, not the raw `otpauth://…` URI: this package
                 * ships no QR encoder, so there is nothing to scan, and most
                 * authenticators reject a pasted `otpauth://…` string anyway —
                 * the key is the only path that reliably works.
                 */}
                {totpSecret(state.totpUri) === undefined ? null : (
                    <>
                        <p className="lunora-auth-note">{t.twoFactorSecret}</p>
                        <code className="lunora-auth-code">{totpSecret(state.totpUri)}</code>
                    </>
                )}
                {state.backupCodes.length === 0 ? null : (
                    <>
                        <p className="lunora-auth-card__description">{t.backupCodes}</p>
                        <ul className="lunora-auth-codes">
                            {state.backupCodes.map((backupCode) => (
                                <li className="lunora-auth-codes__item" key={backupCode}>
                                    {backupCode}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
                <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.verify)}>
                    <Field
                        autoComplete="one-time-code"
                        field={state.code}
                        label={t.codeLabel}
                        name="code"
                        onBlur={() => undefined}
                        onChange={actions.setCode}
                    />
                    <SubmitButton pending={pending}>{t.twoFactor}</SubmitButton>
                </form>
            </AuthCard>
        );
    }

    return (
        <AuthCard title={t.twoFactorSetup}>
            <FormBanner error={state.error} />
            <form className="lunora-auth-form" noValidate onSubmit={onSubmit(actions.enable)}>
                <Field
                    autoComplete="current-password"
                    field={state.password}
                    label={t.passwordLabel}
                    name="password"
                    onBlur={() => undefined}
                    onChange={actions.setPassword}
                    type="password"
                />
                <SubmitButton pending={pending}>{t.twoFactorEnable}</SubmitButton>
            </form>
        </AuthCard>
    );
};

export { TwoFactorSetupCard };
