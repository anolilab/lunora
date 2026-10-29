import { aroundEach } from "vitest";

import runAuthMetricsScenarios from "../_scenarios/auth-metrics";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runAuthMetricsScenarios(createWorkerdExec);
