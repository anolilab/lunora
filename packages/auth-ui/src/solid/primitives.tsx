import type { JSX } from "solid-js";
import { createUniqueId, For, Index, Show } from "solid-js";

import { providerLabel } from "../core/labels";
import type { FieldState } from "../core/types";
import { useAuthUI, useAuthUILink } from "./provider";

/** Card shell: heading, optional description, and body. */
interface AuthCardProps {
    children: JSX.Element;
    description?: string;
    footer?: JSX.Element;
    title: string;
}

/**
 * The provider's resolved `theme` tokens as an inline style. Empty (and so
 * `undefined`) unless the app configured `theme`, which keeps the rendered
 * markup — and the app's own design-token inheritance — untouched by default.
 */
const themeStyle = (): Record<string, string> | undefined => {
    const { themeVariables } = useAuthUI();

    return Object.keys(themeVariables).length === 0 ? undefined : { ...themeVariables };
};

const AuthCard = (props: AuthCardProps): JSX.Element => (
    <section class="lunora-auth-card" style={themeStyle()}>
        <header class="lunora-auth-card__header">
            <h1 class="lunora-auth-card__title">{props.title}</h1>
            <Show when={props.description !== undefined}>
                <p class="lunora-auth-card__description">{props.description}</p>
            </Show>
        </header>
        <div class="lunora-auth-card__body">{props.children}</div>
        <Show when={props.footer !== undefined}>
            <footer class="lunora-auth-card__footer">{props.footer}</footer>
        </Show>
    </section>
);

/** A labelled text input wired to a core {@link FieldState}. */
interface FieldProps {
    autoComplete?: string;
    field: FieldState;
    label: string;
    name: string;
    onBlur: () => void;
    onChange: (value: string) => void;
    placeholder?: string;
    type?: "email" | "password" | "text";
}

const Field = (props: FieldProps): JSX.Element => {
    const id = createUniqueId();
    const errorId = `${id}-error`;
    const showError = (): boolean => props.field.touched && props.field.error !== undefined;

    return (
        <div class="lunora-auth-field">
            <label class="lunora-auth-field__label" for={id}>
                {props.label}
            </label>
            <input
                aria-describedby={showError() ? errorId : undefined}
                aria-invalid={showError()}
                autocomplete={props.autoComplete}
                class="lunora-auth-field__input"
                id={id}
                name={props.name}
                onBlur={() => {
                    props.onBlur();
                }}
                onInput={(event) => {
                    props.onChange(event.currentTarget.value);
                }}
                placeholder={props.placeholder}
                type={props.type ?? "text"}
                value={props.field.value}
            />
            <Show when={showError()}>
                <p class="lunora-auth-field__error" id={errorId}>
                    {props.field.error}
                </p>
            </Show>
        </div>
    );
};

/** Primary submit button with a pending state. */
interface SubmitButtonProps {
    children: JSX.Element;
    pending: boolean;
}

const SubmitButton = (props: SubmitButtonProps): JSX.Element => (
    <button class="lunora-auth-button" disabled={props.pending} type="submit">
        <Show when={props.pending}>
            <span aria-hidden="true" class="lunora-auth-button__spinner" />
        </Show>
        {props.children}
    </button>
);

/** Top-level error / success banner (error is announced via `role="alert"`). */
interface FormBannerProps {
    error?: string;
    success?: string;
}

const FormBanner = (props: FormBannerProps): JSX.Element => (
    <Show
        fallback={
            <Show when={props.success !== undefined}>
                <p class="lunora-auth-banner lunora-auth-banner--success" role="status">
                    {props.success}
                </p>
            </Show>
        }
        when={props.error !== undefined}
    >
        <p class="lunora-auth-banner lunora-auth-banner--error" role="alert">
            {props.error}
        </p>
    </Show>
);

/** Internal link using the provider's framework `Link` when present, else `<a>`. */
interface AuthLinkProps {
    children: JSX.Element;
    href: string;
}

const AuthLink = (props: AuthLinkProps): JSX.Element => {
    const Link = useAuthUILink();

    if (Link) {
        return (
            <Link class="lunora-auth-link" href={props.href}>
                {props.children}
            </Link>
        );
    }

    return (
        <a class="lunora-auth-link" href={props.href}>
            {props.children}
        </a>
    );
};

/**
 * OAuth provider buttons. Rendered only when there are providers — which, with
 * server discovery on, is whatever `socialProviders` the deployment configured.
 *
 * The provider's brand mark is left to CSS: each button carries a
 * `lunora-auth-social__icon--<provider>` class, so an app drops in its own icon
 * set with a stylesheet rule and this package ships no SVG payload for a list of
 * providers it can't know in advance.
 */
interface SocialButtonsProps {
    /** Highlight the provider used last on this device, when known. */
    lastUsed?: string;
    onSelect: (provider: string) => void;
    providers: ReadonlyArray<string>;
}

const SocialButtons = (props: SocialButtonsProps): JSX.Element => {
    const { localization: t } = useAuthUI();

    return (
        <Show when={props.providers.length > 0}>
            <div class="lunora-auth-social">
                <For each={props.providers}>
                    {(provider) => (
                        <button
                            class="lunora-auth-button lunora-auth-button--secondary lunora-auth-social__button"
                            onClick={() => {
                                props.onSelect(provider);
                            }}
                            type="button"
                        >
                            <span aria-hidden="true" class={`lunora-auth-social__icon lunora-auth-social__icon--${provider}`} />
                            <span class="lunora-auth-social__label">{`${t.signInWith} ${providerLabel(provider)}`}</span>
                            <Show when={props.lastUsed === provider}>
                                <span class="lunora-auth-social__badge">{t.lastUsed}</span>
                            </Show>
                        </button>
                    )}
                </For>
            </div>
        </Show>
    );
};

/**
 * A loading placeholder sized in rows. Purely decorative, and hidden from the
 * accessibility tree: the region it fills is already announced as busy by the
 * card that owns it, and a screen reader has no use for "three grey boxes".
 *
 * `Index` rather than `For`: the rows have no identity to key on, and `For`
 * would try to diff a list of indistinguishable placeholders.
 */
const Skeleton = (props: { rows?: number }): JSX.Element => (
    <div aria-hidden="true" class="lunora-auth-skeleton">
        <Index each={Array.from({ length: props.rows ?? 3 })}>{() => <span class="lunora-auth-skeleton__row" />}</Index>
    </div>
);

/** A labelled visual separator ("or"). */
const AuthDivider = (props: { label?: string }): JSX.Element => (
    <div class="lunora-auth-divider" role="separator">
        <span class="lunora-auth-divider__label">{props.label ?? "or"}</span>
    </div>
);

export type { AuthCardProps, FieldProps };
export { AuthCard, AuthDivider, AuthLink, Field, FormBanner, Skeleton, SocialButtons, SubmitButton, themeStyle };
