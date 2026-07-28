/**
 * The OAuth-provider cards, mirroring the React `oauth-provider.tsx` 1:1: the
 * consent screen a third-party application redirects into, and the list of
 * applications that consent can be taken back from.
 */
import type { OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, inject, Injector, input } from "@angular/core";

import type { ResourceState } from "../core/create-resource-controller";
import { isFlowEnabled } from "../core/flow-gate";
import type { AuthorizedAppsActions, ConsentActions, ConsentState } from "../core/oauth-provider";
import { createAuthorizedAppsController, createConsentController, scopeLabels } from "../core/oauth-provider";
import type { OAuthConsent } from "../core/types";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, FormBannerComponent, SkeletonComponent } from "./primitives";
import { injectAuthUIContext } from "./provider";

/**
 * The consent screen a third-party application redirects the user into.
 *
 * Deliberately plain: it names the application, lists exactly what it is asking
 * for, and offers two equally-weighted answers. Nothing is pre-selected and
 * there is no "remember this" shortcut — an authorization prompt that is easier
 * to approve than to read is the failure mode this screen exists to avoid.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SkeletonComponent],
    selector: "lunora-consent-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.consentTitle">
                <lunora-auth-banner [error]="state().error" />
                @if (state().loading) {
                    <lunora-auth-skeleton [rows]="3" />
                } @else if (state().request !== undefined) {
                    <p class="lunora-auth-note">
                        <strong>{{ application() }}</strong> {{ t.consentWants }}
                    </p>
                    <ul class="lunora-auth-list">
                        @for (scope of scopes(); track scope) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{{ scope }}</span>
                            </li>
                        }
                    </ul>
                    <div class="lunora-auth-actions">
                        <!-- Deny first in the DOM: it is the safe answer, so it is the one a keyboard reaches first. -->
                        <button
                            class="lunora-auth-button lunora-auth-button--secondary"
                            type="button"
                            [disabled]="state().status === 'submitting'"
                            (click)="deny()"
                        >
                            {{ t.consentDeny }}
                        </button>
                        <button class="lunora-auth-button" type="button" [disabled]="state().status === 'submitting'" (click)="allow()">
                            {{ t.consentAllow }}
                        </button>
                    </div>
                }
            </lunora-auth-card>
        }
    `,
})
class ConsentCardComponent implements OnInit {
    /** Defaults to `?consent_id=` from the URL. */
    readonly consentId = input<string>();

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "oauthProvider", "ConsentCard"));
    protected readonly t = this.context().localization;
    protected state!: Signal<ConsentState>;
    private actions!: ConsentActions;

    // Lazy, so they are only read once `state` exists — the template reaches
    // them from inside the `@else if` that already proved a request loaded.
    protected readonly application = computed(() => this.state().request?.clientName ?? this.state().request?.clientId);
    protected readonly scopes = computed(() => scopeLabels(this.state().request?.scope));

    // Built in ngOnInit, not a field initializer: `consentId()` is unbound until
    // Angular has set the inputs, so the controller would read the URL's id even
    // when the caller passed one of their own.
    ngOnInit(): void {
        const search = (globalThis as { location?: { search?: string } }).location?.search;
        const resolved = this.consentId() ?? (search === undefined ? undefined : (new URLSearchParams(search).get("consent_id") ?? undefined));
        const bridge = controllerSignal((context) => createConsentController(context, { autoLoad: this.enabled(), consentId: resolved }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }

    protected allow(): void {
        void this.actions.accept();
    }

    protected deny(): void {
        void this.actions.deny();
    }
}

/**
 * Applications the user has authorized, with revoke — the place a granted
 * consent can be taken back. Without it, the consent screen is a one-way door.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent, SkeletonComponent],
    selector: "lunora-authorized-apps-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.authorizedApps">
                <lunora-auth-banner [error]="state().error" />
                @if (state().loading) {
                    <lunora-auth-skeleton [rows]="2" />
                } @else {
                    <ul class="lunora-auth-list">
                        @for (consent of state().items; track consent.id) {
                            <li class="lunora-auth-list__item">
                                <span class="lunora-auth-list__label">{{ consent.clientName ?? consent.clientId }}</span>
                                <button
                                    class="lunora-auth-button lunora-auth-button--danger"
                                    type="button"
                                    [disabled]="state().busy"
                                    (click)="revoke(consent.id ?? '')"
                                >
                                    {{ t.revokeAccess }}
                                </button>
                            </li>
                        }
                        @if (state().items.length === 0) {
                            <li class="lunora-auth-list__empty">{{ t.authorizedAppsEmpty }}</li>
                        }
                    </ul>
                }
            </lunora-auth-card>
        }
    `,
})
class AuthorizedAppsCardComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => isFlowEnabled(this.context(), "oauthProvider", "AuthorizedAppsCard"));
    protected readonly t = this.context().localization;
    private readonly bridge = controllerSignal((context) => createAuthorizedAppsController(context, { autoLoad: this.enabled() }), { context: this.context });
    protected readonly state: Signal<ResourceState<OAuthConsent>> = this.bridge.state;
    private readonly actions: AuthorizedAppsActions = this.bridge.actions;

    protected revoke(consentId: string): void {
        void this.actions.revoke(consentId);
    }
}

export { AuthorizedAppsCardComponent, ConsentCardComponent };
