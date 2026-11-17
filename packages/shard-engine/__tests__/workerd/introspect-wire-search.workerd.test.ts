import { aroundEach } from "vitest";

import runWireSearchScenarios from "../_scenarios/introspect.wire-search";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runWireSearchScenarios(createWorkerdExec);
