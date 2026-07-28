/**
 * Two-factor setup card (security), mirroring the React
 * `two-factor-setup-card.tsx` 1:1: the `start` step collects a password to enable
 * 2FA, `verify` shows the TOTP URI + backup codes and takes the first code, and
 * `enabled` offers a disable form. A single standalone component over the bespoke
 * setup controller.
 */
import type { Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component } from "@angular/core";

import type { TwoFactorSetupActions, TwoFactorSetupState } from "../core/two-factor-setup";
import { isFlowEnabled } from "../core/flow-gate";
import { createTwoFactorSetupController } from "../core/two-factor-setup";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent } from "./primitives";
import { injectAuthUI } from "./provider";

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, AuthFieldComponent, FormBannerComponent, SubmitButtonComponent],
    selector: "lunora-two-factor-setup-card",
    standalone: true,
    template: `
        @if (enabled) {
            @if (state().step === "enabled") {
                <lunora-auth-card [title]="t.twoFactorSetup">
                    <lunora-auth-banner [error]="state().error" [success]="t.twoFactorEnabled" />
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.disable()">
                        <lunora-auth-field
                            [field]="state().password"
                            [label]="t.passwordLabel"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            (changed)="actions.setPassword($event)"
                        />
                        <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.twoFactorDisable }}</lunora-auth-submit-button>
                    </form>
                </lunora-auth-card>
            } @else if (state().step === "verify") {
                <lunora-auth-card [title]="t.twoFactorSetup" [description]="t.twoFactorScan">
                    <lunora-auth-banner [error]="state().error" />
                    @if (state().totpUri !== undefined) {
                        <code class="lunora-auth-code">{{ state().totpUri }}</code>
                    }
                    @if (state().backupCodes.length > 0) {
                        <p class="lunora-auth-card__description">{{ t.backupCodes }}</p>
                        <ul class="lunora-auth-codes">
                            @for (backupCode of state().backupCodes; track backupCode) {
                                <li class="lunora-auth-codes__item">{{ backupCode }}</li>
                            }
                        </ul>
                    }
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.verify()">
                        <lunora-auth-field
                            [field]="state().code"
                            [label]="t.codeLabel"
                            name="code"
                            autoComplete="one-time-code"
                            (changed)="actions.setCode($event)"
                        />
                        <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.twoFactor }}</lunora-auth-submit-button>
                    </form>
                </lunora-auth-card>
            } @else {
                <lunora-auth-card [title]="t.twoFactorSetup">
                    <lunora-auth-banner [error]="state().error" />
                    <form class="lunora-auth-form" novalidate (submit)="$event.preventDefault(); actions.enable()">
                        <lunora-auth-field
                            [field]="state().password"
                            [label]="t.passwordLabel"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            (changed)="actions.setPassword($event)"
                        />
                        <lunora-auth-submit-button [pending]="state().status === 'submitting'">{{ t.twoFactorEnable }}</lunora-auth-submit-button>
                    </form>
                </lunora-auth-card>
            }
        }
    `,
})
class TwoFactorSetupCardComponent {
    private readonly context = injectAuthUI();
    protected readonly enabled = isFlowEnabled(this.context, "twoFactor", "TwoFactorSetupCard");
    protected readonly t = this.context.localization;
    private readonly bridge = controllerSignal(createTwoFactorSetupController, { context: this.context });
    protected readonly state: Signal<TwoFactorSetupState> = this.bridge.state;
    protected readonly actions: TwoFactorSetupActions = this.bridge.actions;
}

export { TwoFactorSetupCardComponent };
