import { aroundEach } from "vitest";

import runMetricHistoryScenarios from "../_scenarios/metric-history";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runMetricHistoryScenarios(createWorkerdExec);
