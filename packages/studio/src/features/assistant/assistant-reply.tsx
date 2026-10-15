import type { ReactElement } from "react";
import { Streamdown } from "streamdown";

/**
 * Element overrides for a rendered reply.
 *
 * Images are DROPPED, not merely sanitized. `rehype-harden` blocks a
 * `javascript:` link but allows every image protocol and prefix, and an image URL
 * in model output is a beacon: it fires on render, it reports that the operator
 * read the reply, and its query string carries whatever the model put there —
 * which, since a turn can read rows, is whatever it just saw. The assistant has
 * no reason to show a remote image, so there is nothing to weigh against that.
 */
const REPLY_COMPONENTS = { img: (): null => null };

/**
 * A reply is markdown. `Streamdown` over a hand-rolled renderer, and over plain
 * `react-markdown`, because what it renders is model output: it ships
 * `rehype-harden` and `rehype-sanitize`, so a reply cannot smuggle raw HTML, a
 * `javascript:` link or a remote image into the console.
 */
const ReplyBody = ({ text }: { readonly text: string }): ReactElement => (
    <div className="prose-sm max-w-none text-xs" data-testid="assistant-turn-body">
        <Streamdown components={REPLY_COMPONENTS}>{text}</Streamdown>
    </div>
);

export default ReplyBody;
