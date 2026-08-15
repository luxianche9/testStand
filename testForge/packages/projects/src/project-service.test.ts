import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "@testforge/storage";
import { ProjectService, projectPath } from "./project-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "testforge-project-service-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.initialize();
  const service = new ProjectService(settings);
  await service.initialize();
  return { root, settings, service };
}

describe("ProjectService folder projects", () => {
  it("starts without an active project and reports requires_project for project operations", async () => {
    const { service } = await fixture();
    expect(service.current()).toBeNull();
    expect(() => service.wiring()).toThrowError(expect.objectContaining({ category: "requires_project" }));
    await expect(service.save()).rejects.toMatchObject({ category: "requires_project" });
  });

  it("initializes and opens the fixed .testforge/project.json manifest", async () => {
    const { root, service } = await fixture();
    const folder = join(root, "bench-a");
    await mkdir(folder);
    expect(await service.inspectFolder(folder)).toMatchObject({ state: "uninitialized", name: "bench-a" });
    const created = await service.initializeFolder(folder);
    expect(created.rootPath).toBe(folder);
    expect(created.path).toBe(projectPath(folder));
    expect(created.file.name).toBe("bench-a");
    await service.leave();
    expect(service.current()).toBeNull();
    expect(await service.openFolder(folder)).toMatchObject({ rootPath: folder, path: projectPath(folder), dirty: false });
  });

  it("saves atomically and never overwrites a damaged manifest", async () => {
    const { root, service } = await fixture();
    const folder = join(root, "bench-b");
    await mkdir(folder);
    await service.initializeFolder(folder);
    service.updateWiring({ nodes: [{ hardwareId: "DUT", x: 10, y: 20, showImage: true, portPositions: {} }], connections: [] });
    await service.save();
    expect(JSON.parse(await readFile(projectPath(folder), "utf8")).wiring.nodes).toHaveLength(1);
    await service.leave();
    await writeFile(projectPath(folder), "{ broken", "utf8");
    expect(await service.inspectFolder(folder)).toMatchObject({ state: "invalid" });
    await expect(service.initializeFolder(folder)).rejects.toMatchObject({ category: "invalid_project" });
    expect(await readFile(projectPath(folder), "utf8")).toBe("{ broken");
  });

  it("opens legacy manifests through the migration chain and persists formatVersion 3", async () => {
    const { root, service } = await fixture();
    const folder = join(root, "legacy");
    await mkdir(dirname(projectPath(folder)), { recursive: true });
    const timestamp = "2025-01-02T03:04:05.000Z";
    await writeFile(projectPath(folder), JSON.stringify({
      formatVersion: 1,
      projectId: "LEGACY",
      name: "Legacy bench",
      wiring: { nodes: [], connections: [] },
      createdAt: timestamp,
      updatedAt: timestamp
    }), "utf8");

    expect(await service.inspectFolder(folder)).toMatchObject({ state: "ready", name: "Legacy bench" });
    const opened = await service.openFolder(folder);
    expect(opened.file).toMatchObject({
      formatVersion: 3,
      projectId: "LEGACY",
      task: { formatVersion: 2, taskId: "LEGACY-task", name: "Legacy bench" }
    });
    expect(JSON.parse(await readFile(projectPath(folder), "utf8"))).toMatchObject({ formatVersion: 3, projectId: "LEGACY" });
  });

  it("rejects future manifest versions without modifying them", async () => {
    const { root, service } = await fixture();
    const folder = join(root, "future");
    await mkdir(dirname(projectPath(folder)), { recursive: true });
    const raw = JSON.stringify({ formatVersion: 99, projectId: "FUTURE" });
    await writeFile(projectPath(folder), raw, "utf8");

    expect(await service.inspectFolder(folder)).toMatchObject({ state: "invalid" });
    await expect(service.openFolder(folder)).rejects.toMatchObject({ category: "invalid_project" });
    expect(await readFile(projectPath(folder), "utf8")).toBe(raw);
  });

  it("keeps all recent projects newest-first, deduplicates canonical paths, and preserves broken entries", async () => {
    const { root, settings, service } = await fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first); await mkdir(second);
    await service.initializeFolder(first);
    service.updateWiring({
      nodes: [
        { hardwareId: "A", x: 0, y: 0, width: 260, height: 190, showImage: true, portPositions: { J1: { side: "right", offset: 0.35 } } },
        { hardwareId: "B", x: 200, y: 100, width: 150, height: 40, showImage: false, portPositions: { J1: { side: "left", offset: 0.65 } } }
      ],
      connections: [{ connectionId: "C", portA: "A.J1", portB: "B.J1", pins: [], confirmedAt: new Date().toISOString(), confirmedBy: "operator" }]
    });
    await service.save();
    await service.initializeFolder(second);
    await service.openFolder(first);
    expect(settings.get().recentProjects.map((item) => item.rootPath)).toEqual([first, second]);
    await rename(projectPath(second), `${projectPath(second)}.broken`);
    const recent = await service.listRecent();
    expect(recent[0]).toMatchObject({ rootPath: first, status: "available", preview: { nodes: expect.any(Array), connections: expect.any(Array) } });
    expect(recent[0]!.preview.nodes).toHaveLength(2);
    expect(recent[0]!.preview.nodes[0]).toMatchObject({ hardwareId: "A", width: 260, height: 190, showImage: true, portPositions: { J1: { side: "right", offset: 0.35 } } });
    expect(recent[0]!.preview.nodes[1]).toMatchObject({ hardwareId: "B", width: 150, height: 40, showImage: false, portPositions: { J1: { side: "left", offset: 0.65 } } });
    expect(recent[0]!.preview.connections).toHaveLength(1);
    expect(recent[0]!.preview.connections[0]).toMatchObject({ connectionId: "C", portA: "A.J1", portB: "B.J1" });
    expect(recent[1]).toMatchObject({ rootPath: second, status: "invalid" });
    await service.forgetRecent(second);
    expect((await service.listRecent()).map((item) => item.rootPath)).toEqual([first]);
  });
});
