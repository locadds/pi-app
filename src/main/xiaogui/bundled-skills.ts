import { basename, dirname, join } from 'node:path'

export interface BundledPiSkillsPathOptions {
  appPath: string
  resourcesPath: string
  isPackaged: boolean
}

function resolveDevelopmentAppRoot(appPath: string): string {
  return basename(appPath) === 'main' && basename(dirname(appPath)) === 'out'
    ? dirname(dirname(appPath))
    : appPath
}

/** Resolve the directory consumed directly by Pi's native Skill loader. */
export function resolveBundledPiSkillsPath(options: BundledPiSkillsPathOptions): string {
  if (options.isPackaged) return join(options.resourcesPath, 'pi-skills')
  return join(resolveDevelopmentAppRoot(options.appPath), 'resources', 'pi-skills')
}
