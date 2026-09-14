const packageRule = (name, allowed) => ({
  name: `${name}-package-boundary`,
  comment: `@hardwareharness/${name} may depend only on ${allowed.join(", ") || "no other workspace package"}.`,
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
    {
      name: "ipc-only-uses-contracts",
      severity: "error",
      from: { path: "^apps/desktop/src/main/ipc\\.ts$" },
      to: { path: "^packages/(?!contracts)[^/]+/src/" }
    },
    {
      name: "typescript-business-backends-stay-removed",
      severity: "error",
      from: { path: "^apps/desktop/src/" },
      to: { path: "^packages/(?:application|devices|projects|wiring|orchestration|storage|mcp-gateway)/src/" }
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
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["hardwareharness-source", "types", "import", "default"] },
    reporterOptions: { dot: { collapsePattern: "^(?:packages/[^/]+|apps/desktop)/" } }
  }
};
