import type { ReactElement } from "react";

import { useT } from "../../i18n/i18n-context";
import ReplyBody from "./assistant-reply";
import TurnFrame from "./assistant-turn-frame";

/**
 * The turn in flight, rendered but not a turn: it carries no copy / branch /
 * insert affordance because there is nothing yet to act on, and it is replaced
 * wholesale by the answer the moment one lands.
 */
const LiveTurn = ({ text }: { readonly text: string }): ReactElement => {
    const t = useT();

    return (
        <TurnFrame label={t("Assistant")} testId="assistant-turn-live">
            <ReplyBody text={text} />
        </TurnFrame>
    );
};

export default LiveTurn;
