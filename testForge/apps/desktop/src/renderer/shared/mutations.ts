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
    client.invalidateQueries({ queryKey: queryKeys.wiringTasks })
  ]);
}
