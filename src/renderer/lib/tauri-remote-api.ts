import type { IpcResult } from '@shared/types/ipc.types'
import type { ProjectSummary } from '@shared/types/web-projects.types'
import { invokeIpc } from './ipc/tauri'

/**
 * One-shot import of the desktop renderer's old project list into the host's
 * durable registry (`project_registry_import`). The host accepts it only while
 * its registry file says nothing was imported: unknown ids are added, existing
 * ones are kept, the default applies only when none is set, and a repeat is an
 * ok no-op (`imported: false`). Either reply is an acknowledgement; the caller
 * deletes the old `projects` key only after one. No env-var values cross the
 * wire — `ProjectSummary` redacts by omission.
 */
export async function projectRegistryImport(
  projects: ProjectSummary[],
  defaultProjectId: string | null
): Promise<IpcResult<{ imported: boolean }>> {
  return invokeIpc<{ imported: boolean }>('project_registry_import', {
    payload: { projects, defaultProjectId }
  })
}
