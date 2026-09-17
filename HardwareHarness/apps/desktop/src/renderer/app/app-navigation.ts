import type { ProjectView } from "@hardwareharness/contracts/storage";

type ContentPage = "welcome" | ProjectView;
export type AppPage = ContentPage | "settings";

export type AppNavigationState = {
  page: AppPage;
  projectView: ProjectView;
  settingsReturnPage: ContentPage;
};

export type AppNavigationAction =
  | { type: "open-settings" }
  | { type: "show-content"; page: ContentPage }
  | { type: "enter-project"; view: ProjectView }
  | { type: "return-from-settings"; hasProject: boolean };

export const initialAppNavigation: AppNavigationState = {
  page: "welcome",
  projectView: "wiring",
  settingsReturnPage: "welcome"
};

export function appNavigationReducer(state: AppNavigationState, action: AppNavigationAction): AppNavigationState {
  if (action.type === "open-settings") {
    if (state.page === "settings") return state;
    return { ...state, page: "settings", settingsReturnPage: state.page };
  }

  if (action.type === "return-from-settings") {
    if (state.page !== "settings") return state;
    const target = !action.hasProject && isProjectView(state.settingsReturnPage) ? "welcome" : state.settingsReturnPage;
    return {
      ...state,
      page: target,
      ...(isProjectView(target) ? { projectView: target } : {})
    };
  }

  const target = action.type === "enter-project" ? action.view : action.page;
  return {
    ...state,
    page: target,
    ...(isProjectView(target) ? { projectView: target } : {})
  };
}

export function isProjectView(page: AppPage): page is ProjectView {
  return page === "wiring" || page === "plans" || page === "manual";
}
