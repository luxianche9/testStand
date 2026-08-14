import type { TestForgeApi } from "@testforge/contracts/desktop";

declare global { interface Window { testforge: TestForgeApi } }
export {};
