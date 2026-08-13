import { useQuery } from "@tanstack/react-query";
import { Spinner } from "./ui.js";

export function HardwareImage({ hardwareId, assetId, alt = "" }: { hardwareId: string; assetId: string; alt?: string }) {
  const url = useQuery({
    queryKey: ["hardware-image", hardwareId, assetId],
    queryFn: () => window.testforge.devices.hardwareImageUrl(hardwareId, assetId),
    staleTime: Infinity
  });
  return url.data ? <img src={url.data} alt={alt} /> : <Spinner />;
}
