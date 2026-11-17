import createSqliteExec from "./_helpers/node-sqlite";
import runQueryMetricsScenarios from "./_scenarios/query-metrics";

runQueryMetricsScenarios(createSqliteExec);
