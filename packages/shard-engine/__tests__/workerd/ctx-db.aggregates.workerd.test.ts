import { aroundEach } from "vitest";

import runAggregateScenarios from "../_scenarios/ctx-db.aggregates";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runAggregateScenarios(createWorkerdExec);
