import { describe, expect, it } from "vitest";
import { appNavigationReducer, initialAppNavigation, type AppNavigationState } from "./app-navigation.js";

describe("app navigation", () => {
  it("returns from settings to the welcome page", () => {
    const settings = appNavigationReducer(initialAppNavigation, { type: "open-settings" });
    expect(settings).toMatchObject({ page: "settings", settingsReturnPage: "welcome" });
    expect(appNavigationReducer(settings, { type: "return-from-settings", hasProject: false }).page).toBe("welcome");
  });

  it("returns to the bench", () => {
    const project = appNavigationReducer(initialAppNavigation, { type: "show-content", page: "bench" });
    const settings = appNavigationReducer(project, { type: "open-settings" });
    const returned = appNavigationReducer(settings, { type: "return-from-settings", hasProject: true });
    expect(returned).toMatchObject({ page: "bench", settingsReturnPage: "bench" });
  });

  it("does not replace the return target when settings is opened again", () => {
    const project = appNavigationReducer(initialAppNavigation, { type: "show-content", page: "bench" });
    const settings = appNavigationReducer(project, { type: "open-settings" });
    expect(appNavigationReducer(settings, { type: "open-settings" })).toBe(settings);
  });

  it("records a new origin after leaving and reopening settings", () => {
    let state: AppNavigationState = appNavigationReducer(initialAppNavigation, { type: "open-settings" });
    state = appNavigationReducer(state, { type: "show-content", page: "bench" });
    state = appNavigationReducer(state, { type: "open-settings" });
    expect(state.settingsReturnPage).toBe("bench");
    expect(appNavigationReducer(state, { type: "return-from-settings", hasProject: true }).page).toBe("bench");
  });

  it("falls back to welcome if the project disappears while settings is open", () => {
    const project = appNavigationReducer(initialAppNavigation, { type: "show-content", page: "bench" });
    const settings = appNavigationReducer(project, { type: "open-settings" });
    expect(appNavigationReducer(settings, { type: "return-from-settings", hasProject: false }).page).toBe("welcome");
  });
});
