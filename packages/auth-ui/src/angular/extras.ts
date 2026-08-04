/**
 * The pieces that sit beside the cards rather than inside them, mirroring the
 * React `extras.tsx` 1:1: the app-shell error toaster, the CAPTCHA widget, the
 * Google One Tap trigger, and the organization logo upload.
 */
import type { ElementRef, OnInit, Signal } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, Injector, input, signal, untracked, viewChild } from "@angular/core";

import { ACCEPT_ATTRIBUTE } from "../core/avatar";
import type { CaptchaProvider } from "../core/captcha";
import { renderCaptcha } from "../core/captcha";
import { promptOneTap } from "../core/one-tap";
import type { LogoUploadActions, LogoUploadState } from "../core/organization-logo";
import { createOrganizationLogoController } from "../core/organization-logo";
import type { Toast } from "../core/toast";
import { dismissToast, getToasts, subscribeToasts } from "../core/toast";
import { controllerSignal } from "./controller-signal";
import { AuthCardComponent, FormBannerComponent } from "./primitives";
import { injectAuthUI, injectAuthUIContext } from "./provider";

/**
 * Renders the errors that have no card to land in — a failed social redirect, a
 * failed unlink, a sign-out that didn't. Mount it once in your app shell.
 *
 * Errors that *do* belong to a card still render on that card's banner and never
 * reach here, so nothing is announced twice.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-error-toaster",
    standalone: true,
    template: `
        @if (toasts().length > 0) {
            <!--
              \`polite\`, not \`assertive\`: these are failures the user can retry, not
              something that should interrupt a screen reader mid-sentence.
            -->
            <div class="lunora-auth-toaster" aria-live="polite">
                @for (toast of toasts(); track toast.id) {
                    <div class="lunora-auth-toast" role="status">
                        <span class="lunora-auth-toast__message">{{ toast.message }}</span>
                        <button class="lunora-auth-toast__dismiss" type="button" aria-label="Dismiss" (click)="dismiss(toast.id)">×</button>
                    </div>
                }
            </div>
        }
    `,
})
class ErrorToasterComponent {
    /*
     * The toast store is module-level, not a controller on the context (see
     * `core/toast.ts`), so this is the one component that bridges a store by
     * hand instead of through `controllerSignal`.
     */
    protected readonly toasts = signal<ReadonlyArray<Toast>>(getToasts());

    /** Delegates to the shared helper — Angular templates can only call members. */
    protected readonly dismiss = dismissToast;

    constructor() {
        const unsubscribe = subscribeToasts(() => {
            this.toasts.set(getToasts());
        });

        inject(DestroyRef).onDestroy(unsubscribe);
    }
}

/**
 * A CAPTCHA widget for the sign-in / sign-up forms.
 *
 * Place it inside the card; it publishes a token that `client.ts` attaches to
 * outgoing auth requests via `captchaHeaders()` (see `core/captcha.ts` — the
 * token is not threaded through the flows). It renders nothing without a
 * `siteKey`, so it is safe to mount unconditionally.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-captcha",
    standalone: true,
    template: `
        @if (siteKey() !== undefined && siteKey() !== "") {
            <div class="lunora-auth-captcha" #host></div>
        }
    `,
})
class CaptchaComponent {
    readonly provider = input.required<CaptchaProvider>();
    readonly siteKey = input<string>();

    private readonly host = viewChild<ElementRef<HTMLElement>>("host");

    /*
     * Captured once, and from the snapshot: the provider hands out a stable
     * wrapper that reads the app's callback at call time, so it survives the
     * context swap discovery causes — and keeping it out of the effect below
     * means a solved widget isn't torn down when that swap lands.
     */
    private readonly onError = injectAuthUI().onError;

    constructor() {
        /*
         * An effect, not `ngOnInit`: it reads the inputs *after* Angular binds
         * them (a field-initializer read would see nothing), re-runs when either
         * input changes, and its cleanup covers both that and destroy — which is
         * what keeps a stale single-use token from outliving the widget.
         */
        effect((onCleanup) => {
            const host = this.host()?.nativeElement;
            const siteKey = this.siteKey();

            if (host === undefined || siteKey === undefined || siteKey === "") {
                return;
            }

            onCleanup(renderCaptcha(host, { onError: this.onError, provider: this.provider(), siteKey }));
        });
    }
}

/**
 * Fires Google One Tap once on mount. Renders nothing — the prompt is Google's
 * own floating UI, not ours.
 *
 * Mount it on the sign-in screen only when signed out; it is an accelerator
 * beside the form, and every reason it declines to appear is normal (see
 * `core/one-tap.ts`).
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-one-tap",
    standalone: true,
    template: "",
})
class OneTapComponent {
    private readonly context = injectAuthUIContext();
    protected readonly enabled = computed(() => this.context().plugins.oneTap);

    /** One prompt per mount: re-prompting on every context change would nag the user. */
    private prompted = false;

    constructor() {
        // Derived rather than read once, because the flag arrives with discovery
        // — a sign-in screen mounted before the server answers would otherwise
        // never prompt.
        effect(() => {
            if (this.prompted || !this.enabled()) {
                return;
            }

            this.prompted = true;
            void promptOneTap(untracked(this.context));
        });
    }
}

/**
 * Upload an organization's logo. Renders only when the app configured an
 * `avatar.upload` handler — without one, `<lunora-organization-settings-card>`'s
 * logo URL field is the fallback.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [AuthCardComponent, FormBannerComponent],
    selector: "lunora-organization-logo-card",
    standalone: true,
    template: `
        @if (enabled()) {
            <lunora-auth-card [title]="t.organizationLogo">
                <lunora-auth-banner [error]="state().error" />
                <div class="lunora-auth-avatar-row">
                    @if (state().logoUrl !== undefined && state().logoUrl !== "") {
                        <img class="lunora-auth-avatar" alt="" [src]="state().logoUrl" />
                    } @else {
                        <span class="lunora-auth-avatar lunora-auth-avatar--initials" aria-hidden="true"></span>
                    }
                    <div class="lunora-auth-avatar-row__actions">
                        <input
                            class="lunora-auth-visually-hidden"
                            type="file"
                            #picker
                            [attr.accept]="accept"
                            [attr.aria-label]="t.avatarUpload"
                            (change)="pick($event)"
                        />
                        <button class="lunora-auth-button" type="button" [disabled]="state().status === 'submitting'" (click)="picker.click()">
                            {{ t.avatarUpload }}
                        </button>
                        @if (state().logoUrl !== undefined && state().logoUrl !== "") {
                            <button
                                class="lunora-auth-button lunora-auth-button--danger"
                                type="button"
                                [disabled]="state().status === 'submitting'"
                                (click)="remove()"
                            >
                                {{ t.avatarRemove }}
                            </button>
                        }
                    </div>
                </div>
            </lunora-auth-card>
        }
    `,
})
class OrganizationLogoCardComponent implements OnInit {
    /** Defaults to the user's active organization. */
    readonly organizationId = input<string>();

    private readonly context = injectAuthUIContext();
    private readonly injector = inject(Injector);
    /** Config *and* discovery, so both halves of the gate re-evaluate. */
    protected readonly enabled = computed(() => this.context().avatar.upload !== undefined && this.context().plugins.organization);
    protected readonly t = this.context().localization;
    protected state!: Signal<LogoUploadState>;
    private actions!: LogoUploadActions;

    protected readonly accept = ACCEPT_ATTRIBUTE;

    // Built in ngOnInit, not a field initializer: `organizationId()` is unbound
    // until Angular has set the inputs, so initializing here would silently pin
    // every instance to the active organization.
    ngOnInit(): void {
        const bridge = controllerSignal((context) => createOrganizationLogoController(context, { organizationId: this.organizationId() }), {
            context: this.context,
            injector: this.injector,
        });

        this.state = bridge.state;
        this.actions = bridge.actions;
    }

    protected pick(event: Event): void {
        // Named `picker`, not `input`: Angular's own `input()` signal helper is
        // imported in this file and shadowing it here reads as a bug.
        const picker = event.target as HTMLInputElement;
        const file = picker.files?.[0];

        // Clear it so re-picking the same file after a failure still fires
        // `change` — browsers suppress it when the value is unchanged.
        picker.value = "";

        if (file) {
            void this.actions.upload(file);
        }
    }

    protected remove(): void {
        void this.actions.remove();
    }
}

export { CaptchaComponent, ErrorToasterComponent, OneTapComponent, OrganizationLogoCardComponent };
