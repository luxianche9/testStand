import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: "testforge-asset", privileges: { secure: true, standard: true, supportFetchAPI: true } }]);
}

export function registerAssetProtocol(resolveImagePath: (hardwareId: string, assetId: string) => string): void {
  protocol.handle("testforge-asset", async (request) => {
    const url = new URL(request.url);
    const [hardwareId, ...rest] = url.pathname.replace(/^\//, "").split("/").map(decodeURIComponent);
    if (!hardwareId || rest.length === 0) return new Response("Not found", { status: 404 });
    try {
      return net.fetch(pathToFileURL(resolveImagePath(hardwareId, rest.join("/"))).toString());
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
  });
}
