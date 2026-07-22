"use client";

import type { ReactElement } from "react";

import { createTwoFactorSetupController } from "../core";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const onSubmit =
    (action: () => unknown) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void action();
    };

const TwoFactorSetupCard = (): ReactElement => {
    const { localization: t } = useAuthUI();
    const [state, actions] = useController(createTwoFactorSetupController);
    const pending = state.status === "submitting";

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
                {state.totpUri === undefined ? null : <code className="lunora-auth-code">{state.totpUri}</code>}
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
