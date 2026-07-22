import type { JSX } from "solid-js";
import { createUniqueId, For, Show } from "solid-js";

import type { FieldState } from "../core";
import { useAuthUILink } from "./provider";

/** Card shell: heading, optional description, and body. */
interface AuthCardProps {
    children: JSX.Element;
    description?: string;
    footer?: JSX.Element;
    title: string;
}

const AuthCard = (props: AuthCardProps): JSX.Element => (
    <section class="lunora-auth-card">
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

/** OAuth provider buttons. Rendered only when the caller passes providers. */
interface SocialButtonsProps {
    onSelect: (provider: string) => void;
    providers: ReadonlyArray<string>;
}

const labelFor = (provider: string): string => provider.charAt(0).toUpperCase() + provider.slice(1);

const SocialButtons = (props: SocialButtonsProps): JSX.Element => (
    <Show when={props.providers.length > 0}>
        <div class="lunora-auth-social">
            <For each={props.providers}>
                {(provider) => (
                    <button
                        class="lunora-auth-button lunora-auth-button--secondary"
                        onClick={() => {
                            props.onSelect(provider);
                        }}
                        type="button"
                    >
                        Continue with {labelFor(provider)}
                    </button>
                )}
            </For>
        </div>
    </Show>
);

/** A labelled visual separator ("or"). */
const AuthDivider = (props: { label?: string }): JSX.Element => (
    <div class="lunora-auth-divider" role="separator">
        <span class="lunora-auth-divider__label">{props.label ?? "or"}</span>
    </div>
);

export type { AuthCardProps, FieldProps };
export { AuthCard, AuthDivider, AuthLink, Field, FormBanner, SocialButtons, SubmitButton };
