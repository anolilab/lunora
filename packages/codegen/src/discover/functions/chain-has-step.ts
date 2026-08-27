import type { Node } from "ts-morph";

import { builderChainSteps } from "../ast";

/** True when the builder chain rooted at `receiver` carries a step whose method name is `method` (`.output(...)` / `.use(...)`). */
const chainHasStep = (receiver: Node, method: string): boolean => builderChainSteps(receiver).some((step) => step.name === method);

export default chainHasStep;
