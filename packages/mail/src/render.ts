import { render } from "@react-email/render";
import type { ReactElement } from "react";

/**
 * Render a React element to an HTML/text pair suitable for inlining into a
 * provider payload. Wraps `@react-email/render` so we can swap to
 * `@visulima/email`'s react-email template engine without touching callers.
 */
export const renderEmail = async (element: ReactElement): Promise<{ html: string; text: string }> => {
    const html = await render(element, { pretty: false });
    const text = await render(element, { plainText: true });

    return { html, text };
};
