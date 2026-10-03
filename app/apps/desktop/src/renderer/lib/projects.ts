import type { ProjectFolderSelection } from "@teststand/contracts/projects";

/** The native folder dialog, then what the backend finds in the chosen folder; null when cancelled. */
export async function chooseProjectFolder(): Promise<ProjectFolderSelection | null> {
  const rootPath = await window.teststand.dialogs.chooseProjectFolder();
  return rootPath ? await window.teststand.projects.inspectFolder({ rootPath }) : null;
}
