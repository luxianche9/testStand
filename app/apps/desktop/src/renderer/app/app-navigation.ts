type ContentPage = "welcome" | "bench";
export type AppPage = ContentPage | "settings";

export type AppNavigationState = {
  page: AppPage;
  settingsReturnPage: ContentPage;
};

export type AppNavigationAction =
  | { type: "open-settings" }
  | { type: "show-content"; page: ContentPage }
  | { type: "return-from-settings"; hasProject: boolean };

export const initialAppNavigation: AppNavigationState = {
  page: "welcome",
  settingsReturnPage: "welcome"
};

export function appNavigationReducer(state: AppNavigationState, action: AppNavigationAction): AppNavigationState {
  if (action.type === "open-settings") {
    if (state.page === "settings") return state;
    return { ...state, page: "settings", settingsReturnPage: state.page };
  }
  if (action.type === "return-from-settings") {
    if (state.page !== "settings") return state;
    const target = !action.hasProject && state.settingsReturnPage === "bench" ? "welcome" : state.settingsReturnPage;
    return { ...state, page: target };
  }
  return { ...state, page: action.page };
}
