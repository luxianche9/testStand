import { describe, expect, it } from "vitest";
import { appNavigationReducer, initialAppNavigation, type AppNavigationState } from "./app-navigation.js";

describe("app navigation", () => {
  it("returns from settings to the welcome page", () => {
    const settings = appNavigationReducer(initialAppNavigation, { type: "open-settings" });
    expect(settings).toMatchObject({ page: "settings", settingsReturnPage: "welcome" });
    expect(appNavigationReducer(settings, { type: "return-from-settings", hasProject: false }).page).toBe("welcome");
  });

  it.each(["wiring", "orchestration", "manual", "logs"] as const)("returns to the %s project page", (view) => {
    const project = appNavigationReducer(initialAppNavigation, { type: "enter-project", view });
    const settings = appNavigationReducer(project, { type: "open-settings" });
    const returned = appNavigationReducer(settings, { type: "return-from-settings", hasProject: true });
    expect(returned).toMatchObject({ page: view, projectView: view, settingsReturnPage: view });
  });

  it("does not replace the return target when settings is opened again", () => {
    const project = appNavigationReducer(initialAppNavigation, { type: "enter-project", view: "orchestration" });
    const settings = appNavigationReducer(project, { type: "open-settings" });
    expect(appNavigationReducer(settings, { type: "open-settings" })).toBe(settings);
  });

  it("records a new origin after leaving and reopening settings", () => {
    let state: AppNavigationState = appNavigationReducer(initialAppNavigation, { type: "enter-project", view: "wiring" });
    state = appNavigationReducer(state, { type: "open-settings" });
    state = appNavigationReducer(state, { type: "show-content", page: "logs" });
    state = appNavigationReducer(state, { type: "open-settings" });
    expect(state.settingsReturnPage).toBe("logs");
    expect(appNavigationReducer(state, { type: "return-from-settings", hasProject: true }).page).toBe("logs");
  });

  it("falls back to welcome if the project disappears while settings is open", () => {
    const project = appNavigationReducer(initialAppNavigation, { type: "enter-project", view: "manual" });
    const settings = appNavigationReducer(project, { type: "open-settings" });
    expect(appNavigationReducer(settings, { type: "return-from-settings", hasProject: false }).page).toBe("welcome");
  });
});
