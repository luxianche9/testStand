import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../../lib/query-keys.js";
import { cn, Spinner } from "../../ui";

/** Loads a stored hardware/port photo and renders it inline. */
export function HardwareImage({ hardwareId, assetId, alt = "", className }: {
  hardwareId: string;
  assetId: string;
  alt?: string;
  className?: string;
}) {
  const url = useQuery({
    queryKey: queryKeys.hardwareImage(hardwareId, assetId),
    queryFn: () => window.hardwareharness.devices.hardwareImageUrl(hardwareId, assetId),
    staleTime: Infinity
  });
  if (!url.data) return <Spinner className="m-2 text-fg-3" />;
  return <img src={url.data} alt={alt} className={cn("block max-w-full object-contain", className)} />;
}
