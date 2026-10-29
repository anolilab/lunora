import { aroundEach } from "vitest";

import runFunctionMetricsScenarios from "../_scenarios/function-metrics";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runFunctionMetricsScenarios(createWorkerdExec);
