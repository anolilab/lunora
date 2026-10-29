"use client";

import type { ReactNode } from "react";

/**
 * The handful of elements every card here is built from. Deliberately plain:
 * class names only, no component library, no Tailwind. The kit is copied into
 * projects that already have a design system, and the first thing anyone does
 * is restyle it — a dependency on someone else's button would make that a
 * removal job instead of a CSS edit.
 */

interface CardProps {
    actions?: ReactNode;
    children: ReactNode;
    subtitle?: string;
    title: string;
}

const Card = ({ actions, children, subtitle, title }: CardProps): ReactNode => (
    <section className="lu-saas-card">
        <header className="lu-saas-card__head">
            <div>
                <h2 className="lu-saas-card__title">{title}</h2>
                {subtitle ? <p className="lu-saas-card__subtitle">{subtitle}</p> : undefined}
            </div>
            {actions ? <div className="lu-saas-card__actions">{actions}</div> : undefined}
        </header>
        {children}
    </section>
);

interface EmptyProps {
    children?: ReactNode;
    title: string;
}

/** What a card shows instead of an empty list. A zero is not an explanation. */
const Empty = ({ children, title }: EmptyProps): ReactNode => (
    <div className="lu-saas-empty">
        <p className="lu-saas-empty__title">{title}</p>
        {children ? <div className="lu-saas-empty__body">{children}</div> : undefined}
    </div>
);

interface FieldErrorProps {
    /** Ties the message to its input for screen readers. */
    id: string;
    message?: string;
}

const FieldError = ({ id, message }: FieldErrorProps): ReactNode =>
    message === undefined ? undefined : (
        <p className="lu-saas-error" id={id} role="alert">
            {message}
        </p>
    );

export type { CardProps, EmptyProps, FieldErrorProps };
export { Card, Empty, FieldError };
