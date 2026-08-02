import type { JSX } from "solid-js";
import { For, Show } from "solid-js";

import { isFlowEnabled } from "../core/flow-gate";
import { createTwoFactorSetupController, totpSecret } from "../core/two-factor-setup";
import { AuthCard, Field, FormBanner, SubmitButton } from "./primitives";
import { useAuthUI } from "./provider";
import { createController } from "./use-controller";

const onSubmit =
    (action: () => unknown) =>
    (event: Event): void => {
        event.preventDefault();
        void action();
    };

const TwoFactorSetupCard = (): JSX.Element => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [state, actions] = createController(createTwoFactorSetupController);

    if (!isFlowEnabled(context, "twoFactor", "TwoFactorSetupCard")) {
        return null;
    }

    return (
        <Show
            fallback={
                <Show
                    fallback={
                        <AuthCard title={t.twoFactorSetup}>
                            <FormBanner error={state.error} />
                            <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.enable)}>
                                <Field
                                    autoComplete="current-password"
                                    field={state.password}
                                    label={t.passwordLabel}
                                    name="password"
                                    onBlur={() => undefined}
                                    onChange={actions.setPassword}
                                    type="password"
                                />
                                <SubmitButton pending={state.status === "submitting"}>{t.twoFactorEnable}</SubmitButton>
                            </form>
                        </AuthCard>
                    }
                    when={state.step === "verify"}
                >
                    <AuthCard description={t.twoFactorScan} title={t.twoFactorSetup}>
                        <FormBanner error={state.error} />
                        {/*
                         * The setup key, not the raw `otpauth://…` URI: this
                         * package ships no QR encoder, so there is nothing to
                         * scan, and most authenticators reject a pasted
                         * `otpauth://…` string anyway — the key is the only
                         * path that reliably works.
                         */}
                        <Show when={totpSecret(state.totpUri) !== undefined}>
                            <p class="lunora-auth-note">{t.twoFactorSecret}</p>
                            <code class="lunora-auth-code">{totpSecret(state.totpUri)}</code>
                        </Show>
                        <Show when={state.backupCodes.length > 0}>
                            <p class="lunora-auth-card__description">{t.backupCodes}</p>
                            <ul class="lunora-auth-codes">
                                <For each={state.backupCodes}>{(backupCode) => <li class="lunora-auth-codes__item">{backupCode}</li>}</For>
                            </ul>
                        </Show>
                        <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.verify)}>
                            <Field
                                autoComplete="one-time-code"
                                field={state.code}
                                label={t.codeLabel}
                                name="code"
                                onBlur={() => undefined}
                                onChange={actions.setCode}
                            />
                            <SubmitButton pending={state.status === "submitting"}>{t.twoFactor}</SubmitButton>
                        </form>
                    </AuthCard>
                </Show>
            }
            when={state.step === "enabled"}
        >
            <AuthCard title={t.twoFactorSetup}>
                <FormBanner error={state.error} success={t.twoFactorEnabled} />
                <form class="lunora-auth-form" noValidate onSubmit={onSubmit(actions.disable)}>
                    <Field
                        autoComplete="current-password"
                        field={state.password}
                        label={t.passwordLabel}
                        name="password"
                        onBlur={() => undefined}
                        onChange={actions.setPassword}
                        type="password"
                    />
                    <SubmitButton pending={state.status === "submitting"}>{t.twoFactorDisable}</SubmitButton>
                </form>
            </AuthCard>
        </Show>
    );
};

export { TwoFactorSetupCard };
