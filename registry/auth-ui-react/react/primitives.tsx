"use client";

import type { ComponentType, ReactElement, ReactNode } from "react";
import { useId } from "react";

import type { FieldState } from "../core";
import { useAuthUILink } from "./provider";

/** Card shell: heading, optional description, and body. */
interface AuthCardProps {
    children: ReactNode;
    description?: string;
    footer?: ReactNode;
    title: string;
}

const AuthCard = ({ children, description, footer, title }: AuthCardProps): ReactElement => (
    <section className="lunora-auth-card">
        <header className="lunora-auth-card__header">
            <h1 className="lunora-auth-card__title">{title}</h1>
            {description === undefined ? null : <p className="lunora-auth-card__description">{description}</p>}
        </header>
        <div className="lunora-auth-card__body">{children}</div>
        {footer === undefined ? null : <footer className="lunora-auth-card__footer">{footer}</footer>}
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

/** OAuth provider buttons. Rendered only when the caller passes providers. */
interface SocialButtonsProps {
    onSelect: (provider: string) => void;
    providers: ReadonlyArray<string>;
}

const labelFor = (provider: string): string => provider.charAt(0).toUpperCase() + provider.slice(1);

const SocialButtons = ({ onSelect, providers }: SocialButtonsProps): ReactElement | null => {
    if (providers.length === 0) {
        return null;
    }

    return (
        <div className="lunora-auth-social">
            {providers.map((provider) => (
                <button
                    className="lunora-auth-button lunora-auth-button--secondary"
                    key={provider}
                    onClick={() => {
                        onSelect(provider);
                    }}
                    type="button"
                >
                    Continue with {labelFor(provider)}
                </button>
            ))}
        </div>
    );
};

/** A labelled visual separator ("or"). */
const AuthDivider = ({ label = "or" }: { label?: string }): ReactElement => (
    <div className="lunora-auth-divider" role="separator">
        <span className="lunora-auth-divider__label">{label}</span>
    </div>
);

export type { AuthCardProps, FieldProps };
export { AuthCard, AuthDivider, AuthLink, Field, FormBanner, SocialButtons, SubmitButton };
