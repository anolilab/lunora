import createSqliteExec from "./_helpers/node-sqlite";
import runMetricHistoryScenarios from "./_scenarios/metric-history";

runMetricHistoryScenarios(createSqliteExec);
