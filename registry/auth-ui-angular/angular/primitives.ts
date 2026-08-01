/**
 * Reusable standalone view primitives, mirroring the React `primitives.tsx`
 * layer 1:1: the card shell, a field bound to a core {@link FieldState}, the
 * submit button, the error/success banner, social buttons, the divider, and the
 * internal link. Every card composes these; they emit the same `lunora-auth-*`
 * class names as the shared stylesheet.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";

import { providerLabel } from "../core/labels";
import { passwordRequirements, passwordScore } from "../core/password-policy";
import type { FieldState } from "../core/types";
import type { AvailabilityStatus } from "../core/username-availability";
import { injectAuthUI, injectAuthUILink } from "./provider";

/** `{ "--border": "red" }` → `--border:red`, or undefined when unthemed. */
const serializeThemeVariables = (variables: Readonly<Record<string, string>>): string | null => {
    const entries = Object.entries(variables);

    // eslint-disable-next-line unicorn/no-null -- Angular removes an attribute binding on `null`; `undefined` leaves it in place.
    return entries.length === 0 ? null : entries.map(([property, value]) => `${property}:${value}`).join(";");
};

/** Card shell: heading, optional description, projected body, optional footer. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-card",
    standalone: true,
    template: `
        <section class="lunora-auth-card" [attr.style]="themeStyle">
            <header class="lunora-auth-card__header">
                @switch (headingLevel()) {
                    @case (2) {
                        <h2 class="lunora-auth-card__title">{{ title() }}</h2>
                    }
                    @case (3) {
                        <h3 class="lunora-auth-card__title">{{ title() }}</h3>
                    }
                    @default {
                        <h1 class="lunora-auth-card__title">{{ title() }}</h1>
                    }
                }
                @if (description() !== undefined) {
                    <p class="lunora-auth-card__description">{{ description() }}</p>
                }
            </header>
            <div class="lunora-auth-card__body">
                <ng-content />
            </div>
            @if (footer()) {
                <footer class="lunora-auth-card__footer">
                    <ng-content select="[lunoraAuthCardFooter]" />
                </footer>
            }
        </section>
    `,
})
class AuthCardComponent {
    /**
     * The provider's resolved `theme` tokens, serialized. Null unless the app
     * configured `theme` — otherwise the app's own design tokens keep flowing
     * through untouched.
     */
    protected readonly themeStyle = serializeThemeVariables(injectAuthUI().themeVariables);
    readonly description = input<string>();
    /** Set true when projecting `[lunoraAuthCardFooter]` content. */
    readonly footer = input(false);

    /**
     * The title's heading level (default 1) — see the React `AuthCard`'s doc
     * comment for why a settings/organization composition passes `2` rather
     * than letting every card render an `h1`.
     */
    readonly headingLevel = input<1 | 2 | 3>(1);
    readonly title = input.required<string>();
}

let fieldIdCounter = 0;

/** A DOM id per instance. Hoisted out of the template literal so the increment is a statement, not an expression buried in a string. */
const nextId = (prefix: string): string => {
    fieldIdCounter += 1;

    return `${prefix}${String(fieldIdCounter)}`;
};

/** A labelled text input wired to a core {@link FieldState}. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-field",
    standalone: true,
    template: `
        <div class="lunora-auth-field">
            <label class="lunora-auth-field__label" [attr.for]="id">{{ label() }}</label>
            <input
                class="lunora-auth-field__input"
                [id]="id"
                [attr.name]="name()"
                [type]="type()"
                [attr.autocomplete]="autoComplete() ?? null"
                [attr.placeholder]="placeholder() ?? null"
                [attr.aria-invalid]="showError()"
                [attr.aria-describedby]="showError() ? errorId : null"
                [value]="field().value"
                (input)="changed.emit($any($event.target).value)"
                (blur)="blurred.emit()"
            />
            @if (showError()) {
                <p class="lunora-auth-field__error" [id]="errorId">{{ field().error }}</p>
            }
        </div>
    `,
})
class AuthFieldComponent {
    readonly autoComplete = input<string>();
    readonly blurred = output();
    readonly changed = output<string>();
    readonly field = input.required<FieldState>();
    readonly label = input.required<string>();
    readonly name = input.required<string>();
    readonly placeholder = input<string>();
    readonly type = input<"email" | "password" | "text">("text");

    protected readonly id = nextId("lunora-auth-field-");
    protected readonly errorId = `${this.id}-error`;
    protected readonly showError = computed(() => this.field().touched && this.field().error !== undefined);
}

/** Primary submit button with a pending state. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-submit-button",
    standalone: true,
    template: `
        <button class="lunora-auth-button" type="submit" [disabled]="pending()">
            @if (pending()) {
                <span class="lunora-auth-button__spinner" aria-hidden="true"></span>
            }
            <ng-content />
        </button>
    `,
})
class SubmitButtonComponent {
    readonly pending = input.required<boolean>();
}

/** Top-level error / success banner (error is announced via `role="alert"`). */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-banner",
    standalone: true,
    template: `
        @if (error() !== undefined) {
            <p class="lunora-auth-banner lunora-auth-banner--error" role="alert">{{ error() }}</p>
        } @else if (success() !== undefined) {
            <p class="lunora-auth-banner lunora-auth-banner--success" role="status">{{ success() }}</p>
        }
    `,
})
class FormBannerComponent {
    readonly error = input<string>();
    readonly success = input<string>();
}

/**
 * OAuth provider buttons. Rendered only when there are providers — which, with
 * server discovery on, is whatever `socialProviders` the deployment configured.
 *
 * The provider's brand mark is left to CSS: each button carries a
 * `lunora-auth-social__icon--&lt;provider>` class, so an app drops in its own icon
 * set with a stylesheet rule and this package ships no SVG payload for a list of
 * providers it can't know in advance.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-social-buttons",
    standalone: true,
    template: `
        @if (providers().length > 0) {
            <div class="lunora-auth-social">
                @for (provider of providers(); track provider) {
                    <button class="lunora-auth-button lunora-auth-button--secondary lunora-auth-social__button" type="button" (click)="select.emit(provider)">
                        <span aria-hidden="true" [class]="'lunora-auth-social__icon lunora-auth-social__icon--' + provider"></span>
                        <span class="lunora-auth-social__label">{{ t.signInWith }} {{ providerLabel(provider) }}</span>
                        @if (lastUsed() === provider) {
                            <span class="lunora-auth-social__badge">{{ t.lastUsed }}</span>
                        }
                    </button>
                }
            </div>
        }
    `,
})
class SocialButtonsComponent {
    /** Highlight the provider used last on this device, when known. */
    readonly lastUsed = input<string>();
    readonly providers = input.required<ReadonlyArray<string>>();
    readonly select = output<string>();

    protected readonly t = injectAuthUI().localization;

    /** Delegates to the shared helper — Angular templates can only call members. */
    protected readonly providerLabel = providerLabel;
}

/**
 * A loading placeholder sized in rows. Purely decorative, and hidden from the
 * accessibility tree: the region it fills is already announced as busy by the
 * card that owns it, and a screen reader has no use for "three grey boxes".
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-skeleton",
    standalone: true,
    template: `
        <div class="lunora-auth-skeleton" aria-hidden="true">
            @for (row of rowIndexes(); track row) {
                <span class="lunora-auth-skeleton__row"></span>
            }
        </div>
    `,
})
class SkeletonComponent {
    readonly rows = input(3);

    // Placeholders have no identity, so the track key is the index — the list is
    // fixed-length and never reordered.
    protected readonly rowIndexes = computed(() => Array.from({ length: this.rows() }, (_unused, index) => index));
}

/** A labelled visual separator ("or"). */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-divider",
    standalone: true,
    template: `
        <div class="lunora-auth-divider" role="separator">
            <span class="lunora-auth-divider__label">{{ label() }}</span>
        </div>
    `,
})
class AuthDividerComponent {
    readonly label = input("or");
}

/** Internal link using the provider's `link` hook when present, else a plain `&lt;a>`. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-link",
    standalone: true,
    template: `<a class="lunora-auth-link" [attr.href]="href()" (click)="onClick($event)"><ng-content /></a>`,
})
class AuthLinkComponent {
    readonly href = input.required<string>();

    private readonly link = injectAuthUILink();

    protected onClick(event: MouseEvent): void {
        // Let the browser handle modified clicks and anything but the primary
        // button, so "open in new tab" still works on an internal link.
        const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;

        if (this.link && !modified) {
            event.preventDefault();
            this.link(this.href());
        }
    }
}

/**
 * The live requirement checklist under a password field.
 *
 * A checklist rather than a bare strength bar: "weak" tells someone their
 * password is unacceptable without telling them what to change. The bar is
 * derived from the same requirements so the two can never disagree.
 *
 * `aria-live="polite"` on the list, because the ticks change as the user types
 * and a screen reader should hear progress without being interrupted mid-word.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-password-strength",
    standalone: true,
    template: `
        @if (value() !== "") {
            <div class="lunora-auth-strength">
                <div class="lunora-auth-strength__bar">
                    <span class="lunora-auth-strength__fill" [style.width.%]="fillPercent()"></span>
                </div>
                <ul class="lunora-auth-strength__list" aria-live="polite">
                    @for (requirement of requirements(); track requirement.label) {
                        <li class="lunora-auth-strength__item" [class.lunora-auth-strength__item--met]="requirement.met">
                            <span aria-hidden="true">{{ requirement.met ? "✓" : "○" }}</span> {{ requirement.label }}
                        </li>
                    }
                </ul>
            </div>
        }
    `,
})
class PasswordStrengthComponent {
    readonly value = input.required<string>();

    private readonly context = injectAuthUI();

    // `computed`, not a field initializer: a signal input cannot be read while
    // the class is being constructed, and this has to re-derive per keystroke.
    protected readonly requirements = computed(() => passwordRequirements(this.value(), this.context.localization, this.context.password));
    protected readonly fillPercent = computed(() => Math.round(passwordScore(this.requirements()) * 100));
}

/**
 * Whether a username is free, shown as the user types.
 *
 * Advisory only — the check races the submit and the server stays the
 * authority — so a failed check ("unknown") reads as nothing rather than as a
 * rejection.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-username-availability",
    standalone: true,
    template: `
        @if (status() !== "idle" && status() !== "unknown") {
            <p [class]="'lunora-auth-availability lunora-auth-availability--' + status()" role="status">{{ message() }}</p>
        }
    `,
})
class UsernameAvailabilityComponent {
    readonly status = input.required<AvailabilityStatus>();

    protected readonly t = injectAuthUI().localization;

    protected readonly message = computed(() => {
        if (this.status() === "checking") {
            return this.t.usernameChecking;
        }

        return this.status() === "taken" ? this.t.usernameTaken : this.t.usernameAvailable;
    });
}

export {
    AuthCardComponent,
    AuthDividerComponent,
    AuthFieldComponent,
    AuthLinkComponent,
    FormBannerComponent,
    PasswordStrengthComponent,
    serializeThemeVariables,
    SkeletonComponent,
    SocialButtonsComponent,
    SubmitButtonComponent,
    UsernameAvailabilityComponent,
};
