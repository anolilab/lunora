import createSqliteExec from "./_helpers/node-sqlite";
import runAuthMetricsScenarios from "./_scenarios/auth-metrics";

runAuthMetricsScenarios(createSqliteExec);
