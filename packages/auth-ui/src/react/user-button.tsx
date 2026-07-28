"use client";

import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { AuthUser } from "../core";
import { createSessionController, userInitials, userLabel } from "../core/session";
import { signOut } from "../core/session-actions";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

/**
 * A user's photo, or their initials when there isn't one.
 *
 * The image is the only thing here that can fail at runtime, so a broken URL
 * falls back to the initials rather than to a browser's broken-image glyph —
 * `user.image` is a plain string column an app can put anything in.
 */
interface UserAvatarProps {
    size?: number;
    user?: AuthUser;
}

const UserAvatar = ({ size = 32, user }: UserAvatarProps): ReactElement => {
    const [failed, setFailed] = useState(false);
    const image = user?.image;
    const onError = useCallback(() => {
        setFailed(true);
    }, []);

    /*
     * A new user means a new image URL, so a previous failure must not stick to
     * it. This is React's adjust-state-during-render pattern rather than a ref
     * compare: reading `ref.current` during render is what `react-hooks-js/refs`
     * forbids, and an effect would paint the fallback for one frame first.
     */
    const [renderedImage, setRenderedImage] = useState(image);

    if (renderedImage !== image) {
        setRenderedImage(image);
        setFailed(false);
    }

    const style = { height: `${size}px`, width: `${size}px` };

    if (image !== undefined && image !== "" && !failed) {
        return <img alt="" className="lunora-auth-avatar" onError={onError} src={image} style={style} />;
    }

    return (
        <span aria-hidden="true" className="lunora-auth-avatar lunora-auth-avatar--initials" style={style}>
            {userInitials(user)}
        </span>
    );
};

/** Avatar + name + email, the block that identifies an account in a list or menu. */
interface UserViewProps {
    /** Hide the email line, for tight rows. */
    compact?: boolean;
    user?: AuthUser;
}

const UserView = ({ compact, user }: UserViewProps): ReactElement => (
    <span className="lunora-auth-user">
        <UserAvatar size={compact === true ? 24 : 36} user={user} />
        <span className="lunora-auth-user__text">
            <span className="lunora-auth-user__name">{userLabel(user)}</span>
            {compact === true || user?.email === undefined ? null : <span className="lunora-auth-user__email">{user.email}</span>}
        </span>
    </span>
);

/**
 * The avatar menu: who is signed in, plus sign-out and whatever the app hangs
 * off it.
 *
 * It is a disclosure rather than a `<menu>` because its contents are app-defined
 * — links, an organization switcher, a theme row — and forcing those into menu
 * item semantics would mislabel them. Escape and outside-click close it, and
 * focus returns to the trigger, which is the part hand-rolled dropdowns usually
 * miss.
 */
interface UserButtonProps {
    /** Extra rows rendered above sign-out (links, an org switcher, …). */
    children?: ReactNode;
    /** Render nothing at all when signed out, instead of a sign-in link. */
    hideWhenSignedOut?: boolean;
}

const UserButton = ({ children, hideWhenSignedOut }: UserButtonProps): ReactElement | null => {
    const context = useAuthUI();
    const { localization: t } = context;
    const [session, sessionActions] = useController(createSessionController);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const menuId = useId();

    const close = useCallback(() => {
        setOpen(false);
        triggerRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                close();
            }
        };

        const onPointerDown = (event: MouseEvent): void => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
                // Not `close()`: a click elsewhere is the user moving on, and
                // yanking focus back to the trigger would fight them for it.
                setOpen(false);
            }
        };

        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown);

        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("mousedown", onPointerDown);
        };
    }, [open, close]);

    // "Not asked yet" and "asked, nobody home" look identical in `user`, and
    // rendering a sign-in link during the first request makes every page flash
    // one. `settled` is the difference.
    if (!session.settled) {
        return <span className="lunora-auth-userbutton lunora-auth-userbutton--loading" />;
    }

    if (!session.user) {
        if (hideWhenSignedOut === true) {
            return null;
        }

        return (
            <a className="lunora-auth-link" href={context.redirects.signIn}>
                {t.signIn}
            </a>
        );
    }

    return (
        <div className="lunora-auth-userbutton" ref={rootRef}>
            <button
                aria-controls={open ? menuId : undefined}
                aria-expanded={open}
                aria-haspopup="true"
                aria-label={userLabel(session.user)}
                className="lunora-auth-userbutton__trigger"
                onClick={() => {
                    setOpen((value) => !value);
                }}
                ref={triggerRef}
                type="button"
            >
                <UserAvatar user={session.user} />
            </button>
            {open ? (
                <div className="lunora-auth-userbutton__menu" id={menuId}>
                    <div className="lunora-auth-userbutton__header">
                        <UserView user={session.user} />
                    </div>
                    {children}
                    <button
                        className="lunora-auth-button lunora-auth-button--secondary"
                        onClick={() => {
                            setOpen(false);
                            void signOut(context).then(sessionActions.refetch);
                        }}
                        type="button"
                    >
                        {t.signOut}
                    </button>
                </div>
            ) : null}
        </div>
    );
};

export type { UserAvatarProps, UserButtonProps, UserViewProps };
export { UserAvatar, UserButton, UserView };
