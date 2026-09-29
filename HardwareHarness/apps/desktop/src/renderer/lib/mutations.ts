import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./query-keys.js";

export async function invalidateDeviceData(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.dashboard }),
    client.invalidateQueries({ queryKey: queryKeys.deviceCatalog })
  ]);
}

export async function invalidateWiringData(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.projectDocument }),
    client.invalidateQueries({ queryKey: queryKeys.deviceCatalog }),
    client.invalidateQueries({ queryKey: queryKeys.wiringTasks }),
    client.invalidateQueries({ queryKey: queryKeys.wiringChanges })
  ]);
}

/** After a 功能测试 mutation (plan saved/created/deleted, run or batch started, unit changed). */
export async function invalidateTestingData(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.testPlans }),
    client.invalidateQueries({ queryKey: queryKeys.testItemStatus }),
    client.invalidateQueries({ queryKey: queryKeys.testRun }),
    client.invalidateQueries({ queryKey: queryKeys.testBatch }),
    client.invalidateQueries({ queryKey: queryKeys.testRunsAll })
  ]);
}
