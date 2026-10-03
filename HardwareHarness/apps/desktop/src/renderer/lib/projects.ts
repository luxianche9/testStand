import type { ProjectFolderSelection } from "@hardwareharness/contracts/projects";

/** The native folder dialog, then what the backend finds in the chosen folder; null when cancelled. */
export async function chooseProjectFolder(): Promise<ProjectFolderSelection | null> {
  const rootPath = await window.hardwareharness.dialogs.chooseProjectFolder();
  return rootPath ? await window.hardwareharness.projects.inspectFolder({ rootPath }) : null;
}
