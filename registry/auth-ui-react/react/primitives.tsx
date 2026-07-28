"use client";

import type { ComponentType, ReactElement, ReactNode } from "react";
import { useId } from "react";

import type { AvailabilityStatus, FieldState } from "../core";
import { providerLabel } from "../core/labels";
import { passwordRequirements, passwordScore } from "../core/password-policy";
import { useAuthUI, useAuthUILink } from "./provider";
import { useThemeStyle } from "./use-theme-style";

/** Card shell: heading, optional description, and body. */
interface AuthCardProps {
    children: ReactNode;
    description?: string;
    footer?: ReactNode;
    title: string;
}

const AuthCard = ({ children, description, footer, title }: AuthCardProps): ReactElement => {
    const style = useThemeStyle();

    return (
        <section className="lunora-auth-card" style={style}>
            <header className="lunora-auth-card__header">
                <h1 className="lunora-auth-card__title">{title}</h1>
                {description === undefined ? null : <p className="lunora-auth-card__description">{description}</p>}
            </header>
            <div className="lunora-auth-card__body">{children}</div>
            {footer === undefined ? null : <footer className="lunora-auth-card__footer">{footer}</footer>}
        </section>
    );
};

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

const Field = ({ autoComplete, field, label, name, onBlur, onChange, placeholder, type = "text" }: FieldProps): ReactElement => {
    const id = useId();
    const errorId = `${id}-error`;
    const showError = field.touched && field.error !== undefined;

    return (
        <div className="lunora-auth-field">
            <label className="lunora-auth-field__label" htmlFor={id}>
                {label}
            </label>
            <input
                aria-describedby={showError ? errorId : undefined}
                aria-invalid={showError}
                autoComplete={autoComplete}
                className="lunora-auth-field__input"
                id={id}
                name={name}
                onBlur={onBlur}
                onChange={(event) => {
                    onChange(event.target.value);
                }}
                placeholder={placeholder}
                type={type}
                value={field.value}
            />
            {showError ? (
                <p className="lunora-auth-field__error" id={errorId}>
                    {field.error}
                </p>
            ) : null}
        </div>
    );
};

/** Primary submit button with a pending state. */
interface SubmitButtonProps {
    children: ReactNode;
    pending: boolean;
}

const SubmitButton = ({ children, pending }: SubmitButtonProps): ReactElement => (
    <button className="lunora-auth-button" disabled={pending} type="submit">
        {pending ? <span aria-hidden="true" className="lunora-auth-button__spinner" /> : null}
        {children}
    </button>
);

/** Top-level error / success banner (error is announced via `role="alert"`). */
interface FormBannerProps {
    error?: string;
    success?: string;
}

const FormBanner = ({ error, success }: FormBannerProps): ReactElement | null => {
    if (error !== undefined) {
        return (
            <p className="lunora-auth-banner lunora-auth-banner--error" role="alert">
                {error}
            </p>
        );
    }

    if (success !== undefined) {
        return (
            <p className="lunora-auth-banner lunora-auth-banner--success" role="status">
                {success}
            </p>
        );
    }

    return null;
};

/** Internal link using the provider's framework `Link` when present, else `&lt;a>`. */
interface AuthLinkProps {
    children: ReactNode;
    href: string;
}

const AuthLink = ({ children, href }: AuthLinkProps): ReactElement => {
    const Link = useAuthUILink() as ComponentType<{ children: ReactNode; className?: string; href: string }> | undefined;

    if (Link) {
        return (
            <Link className="lunora-auth-link" href={href}>
                {children}
            </Link>
        );
    }

    return (
        <a className="lunora-auth-link" href={href}>
            {children}
        </a>
    );
};

/**
 * A "last used" marker, shown against whichever sign-in route the user took
 * last time.
 *
 * A standalone primitive rather than something only `&lt;SocialButtons>` renders,
 * because better-auth records `email`, `magic-link` and `passkey` as well as
 * provider ids: badging only the OAuth buttons makes the feature invisible for
 * the most common case there is.
 */
const LastUsedBadge = (): ReactElement => {
    const { localization: t } = useAuthUI();

    return <span className="lunora-auth-social__badge">{t.lastUsed}</span>;
};

/**
 * OAuth provider buttons. Rendered only when there are providers — which, with
 * server discovery on, is whatever `socialProviders` the deployment configured.
 *
 * The provider's brand mark is left to CSS: each button carries a
 * `lunora-auth-social__icon--&lt;provider>` class, so an app drops in its own icon
 * set with a stylesheet rule and this package ships no SVG payload for a list of
 * providers it can't know in advance.
 */
interface SocialButtonsProps {
    /** Highlight the provider used last on this device, when known. */
    lastUsed?: string;
    onSelect: (provider: string) => void;
    providers: ReadonlyArray<string>;
}

const SocialButtons = ({ lastUsed, onSelect, providers }: SocialButtonsProps): ReactElement | null => {
    const { localization: t } = useAuthUI();

    if (providers.length === 0) {
        return null;
    }

    return (
        <div className="lunora-auth-social">
            {providers.map((provider) => (
                <button
                    className="lunora-auth-button lunora-auth-button--secondary lunora-auth-social__button"
                    key={provider}
                    onClick={() => {
                        onSelect(provider);
                    }}
                    type="button"
                >
                    <span aria-hidden="true" className={`lunora-auth-social__icon lunora-auth-social__icon--${provider}`} />
                    <span className="lunora-auth-social__label">{`${t.signInWith} ${providerLabel(provider)}`}</span>
                    {lastUsed === provider ? <LastUsedBadge /> : null}
                </button>
            ))}
        </div>
    );
};

/**
 * A loading placeholder sized in rows. Purely decorative, and hidden from the
 * accessibility tree: the region it fills is already announced as busy by the
 * card that owns it, and a screen reader has no use for "three grey boxes".
 */
const Skeleton = ({ rows = 3 }: { rows?: number }): ReactElement => (
    <div aria-hidden="true" className="lunora-auth-skeleton">
        {Array.from({ length: rows }, (_, index) => (
            <span className="lunora-auth-skeleton__row" key={index} />
        ))}
    </div>
);

/** A labelled visual separator ("or"). */
const AuthDivider = ({ label = "or" }: { label?: string }): ReactElement => (
    <div className="lunora-auth-divider" role="separator">
        <span className="lunora-auth-divider__label">{label}</span>
    </div>
);

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
const PasswordStrength = ({ value }: { value: string }): ReactElement | null => {
    const { localization, password } = useAuthUI();

    if (value === "") {
        return null;
    }

    const requirements = passwordRequirements(value, localization, password);
    const score = passwordScore(requirements);

    return (
        <div className="lunora-auth-strength">
            <div className="lunora-auth-strength__bar">
                <span className="lunora-auth-strength__fill" style={{ width: `${String(Math.round(score * 100))}%` }} />
            </div>
            <ul aria-live="polite" className="lunora-auth-strength__list">
                {requirements.map((requirement) => (
                    <li className={`lunora-auth-strength__item${requirement.met ? " lunora-auth-strength__item--met" : ""}`} key={requirement.label}>
                        <span aria-hidden="true">{requirement.met ? "✓" : "○"}</span> {requirement.label}
                    </li>
                ))}
            </ul>
        </div>
    );
};

/**
 * Whether a username is free, shown as the user types.
 *
 * Advisory only — the check races the submit and the server stays the
 * authority — so a failed check reads as nothing rather than as a rejection.
 */
const UsernameAvailability = ({ status }: { status: AvailabilityStatus }): ReactElement | null => {
    const { localization: t } = useAuthUI();

    if (status === "idle" || status === "unknown") {
        return null;
    }

    const messages: Record<string, string> = { available: t.usernameAvailable, checking: t.usernameChecking, taken: t.usernameTaken };
    const message = messages[status] ?? t.usernameAvailable;

    return (
        <p className={`lunora-auth-availability lunora-auth-availability--${status}`} role="status">
            {message}
        </p>
    );
};

export type { AuthCardProps, FieldProps };
export { AuthCard, AuthDivider, AuthLink, Field, FormBanner, LastUsedBadge, PasswordStrength, Skeleton, SocialButtons, SubmitButton, UsernameAvailability };
