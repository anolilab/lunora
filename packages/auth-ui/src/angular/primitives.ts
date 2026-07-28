/**
 * Reusable standalone view primitives, mirroring the React `primitives.tsx`
 * layer 1:1: the card shell, a field bound to a core {@link FieldState}, the
 * submit button, the error/success banner, social buttons, the divider, and the
 * internal link. Every card composes these; they emit the same `lunora-auth-*`
 * class names as the shared stylesheet.
 */
import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";

import type { FieldState } from "../core/types";
import { injectAuthUI, injectAuthUILink } from "./provider";

/** `{ "--border": "red" }` → `--border:red`, or null when unthemed. */
const serializeThemeVariables = (variables: Readonly<Record<string, string>>): string | null => {
    const entries = Object.entries(variables);

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
                <h1 class="lunora-auth-card__title">{{ title() }}</h1>
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
    readonly title = input.required<string>();
}

let fieldIdCounter = 0;

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
    readonly blurred = output<void>();
    readonly changed = output<string>();
    readonly field = input.required<FieldState>();
    readonly label = input.required<string>();
    readonly name = input.required<string>();
    readonly placeholder = input<string>();
    readonly type = input<"email" | "password" | "text">("text");

    protected readonly id = `lunora-auth-field-${(fieldIdCounter += 1)}`;
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

/** OAuth provider buttons. Rendered only when the caller passes providers. */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: "lunora-auth-social-buttons",
    standalone: true,
    template: `
        @if (providers().length > 0) {
            <div class="lunora-auth-social">
                @for (provider of providers(); track provider) {
                    <button class="lunora-auth-button lunora-auth-button--secondary" type="button" (click)="select.emit(provider)">
                        Continue with {{ labelFor(provider) }}
                    </button>
                }
            </div>
        }
    `,
})
class SocialButtonsComponent {
    readonly providers = input.required<ReadonlyArray<string>>();
    readonly select = output<string>();

    protected labelFor(provider: string): string {
        return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
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

/** Internal link using the provider's `link` hook when present, else a plain `<a>`. */
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

export {
    AuthCardComponent,
    AuthDividerComponent,
    AuthFieldComponent,
    AuthLinkComponent,
    FormBannerComponent,
    serializeThemeVariables,
    SocialButtonsComponent,
    SubmitButtonComponent,
};
