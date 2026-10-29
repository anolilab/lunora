import createSqliteExec from "./_helpers/node-sqlite";
import runFunctionMetricsScenarios from "./_scenarios/function-metrics";

runFunctionMetricsScenarios(createSqliteExec);
