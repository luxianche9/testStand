const packageRule = (name, allowed) => ({
  name: `${name}-package-boundary`,
  comment: `@testforge/${name} may depend only on ${allowed.join(", ") || "no other workspace package"}.`,
  severity: "error",
  from: { path: `^packages/${name}/src/`, pathNot: "\\.(?:test|spec)\\.[cm]?[jt]sx?$" },
  to: { path: `^packages/(?!${[name, ...allowed].join("|")})(?:[^/]+)/src/` }
});

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Circular dependencies make package and feature boundaries unstable.",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true }
    },
    {
      name: "packages-must-not-depend-on-desktop",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/desktop/" }
    },
    packageRule("contracts", []),
    packageRule("storage", ["contracts"]),
    packageRule("devices", ["contracts", "storage"]),
    packageRule("projects", ["contracts", "storage"]),
    packageRule("wiring", ["contracts"]),
    packageRule("orchestration", ["contracts"]),
    packageRule("application", ["contracts", "devices", "projects", "wiring", "orchestration"]),
    packageRule("mcp-gateway", ["contracts", "application"]),
    {
      name: "ipc-only-uses-application-and-contracts",
      severity: "error",
      from: { path: "^apps/desktop/src/main/ipc\\.ts$" },
      to: { path: "^packages/(?!application|contracts)[^/]+/src/" }
    },
    {
      name: "concrete-services-stay-in-composition",
      severity: "error",
      from: { path: "^apps/desktop/src/main/", pathNot: "^apps/desktop/src/main/(?:composition|migrations)(?:\\.test)?\\.ts$" },
      to: { path: "^packages/(?:devices|projects|wiring|orchestration|storage|mcp-gateway)/src/" }
    },
    ...["agent", "devices", "projects", "wiring", "orchestration"].map((feature) => ({
      name: `renderer-${feature}-feature-isolated`,
      severity: "error",
      from: { path: `^apps/desktop/src/renderer/features/${feature}/` },
      to: {
        path: `^apps/desktop/src/renderer/features/(?!${feature}/)`,
        pathNot: feature === "projects"
          ? "^apps/desktop/src/renderer/features/(?:[^/]+/index\\.ts|wiring/TopologyPreview\\.tsx)$"
          : "^apps/desktop/src/renderer/features/[^/]+/index\\.ts$"
      }
    })),
    {
      name: "packages-must-not-depend-on-theia",
      comment: "Domain packages must stay Theia-agnostic; only the IDE shell may reference @theia/*.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "node_modules/@theia/" }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["testforge-source", "types", "import", "default"] },
    reporterOptions: { dot: { collapsePattern: "^(?:packages/[^/]+|apps/desktop)/" } }
  }
};
