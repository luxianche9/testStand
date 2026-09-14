import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: "hardwareharness-asset", privileges: { secure: true, standard: true, supportFetchAPI: true } }]);
}

export function registerAssetProtocol(resolveImagePath: (hardwareId: string, assetId: string) => string | Promise<string>): void {
  protocol.handle("hardwareharness-asset", async (request) => {
    const url = new URL(request.url);
    const [hardwareId, ...rest] = url.pathname.replace(/^\//, "").split("/").map(decodeURIComponent);
    if (!hardwareId || rest.length === 0) return new Response("Not found", { status: 404 });
    try {
      return await net.fetch(pathToFileURL(await resolveImagePath(hardwareId, rest.join("/"))).toString());
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
  });
}
