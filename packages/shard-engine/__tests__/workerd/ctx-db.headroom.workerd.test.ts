import { aroundEach } from "vitest";

import runHeadroomScenarios from "../_scenarios/ctx-db.headroom";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runHeadroomScenarios(createWorkerdExec);
