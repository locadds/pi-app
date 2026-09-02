import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { ProjectWorkspaceResolverV1 } from './attempt-workspace'
import { normalizePathKey } from '../path-key'
import { opaqueScopeIdDeriverV1 } from '../scope-derive'

export interface ProjectWorkspaceCandidatesV1 {
  readonly currentProject: string | null
  readonly recentProjects: readonly string[]
}

export type ProjectWorkspaceCandidateSourceV1 =
  () => ProjectWorkspaceCandidatesV1 | Promise<ProjectWorkspaceCandidatesV1>

export type ProjectWorkspaceResolutionReasonCodeV1 =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_AMBIGUOUS'
  | 'PROJECT_PATH_UNAVAILABLE'
  | 'PROJECT_NOT_DIRECTORY'

export class ProjectWorkspaceResolutionErrorV1 extends Error {
  constructor(readonly reasonCode: ProjectWorkspaceResolutionReasonCodeV1) {
    super(reasonCode)
    this.name = 'ProjectWorkspaceResolutionErrorV1'
  }
}

interface ProjectWorkspaceFileSystemV1 {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

export interface MainProjectWorkspaceResolverOptionsV1 {
  readonly source?: ProjectWorkspaceCandidateSourceV1
  /** Test seam only; production uses node:fs/promises. */
  readonly fileSystem?: ProjectWorkspaceFileSystemV1
}

const nodeFileSystemV1: ProjectWorkspaceFileSystemV1 = { realpath, stat }

const configStoreCandidateSourceV1: ProjectWorkspaceCandidateSourceV1 = async () => {
  // Keep electron-store outside this module's import graph until the production
  // default is actually used. Injected tests remain plain Node tests.
  const { configStore } = await import('../../config-store')
  return {
    currentProject: configStore.get('currentProject'),
    recentProjects: configStore.get('recentProjects'),
  }
}

function candidatePaths(snapshot: ProjectWorkspaceCandidatesV1): string[] {
  if (!snapshot || !Array.isArray(snapshot.recentProjects)) {
    throw new ProjectWorkspaceResolutionErrorV1('PROJECT_PATH_UNAVAILABLE')
  }

  const candidates = [snapshot.currentProject, ...snapshot.recentProjects]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of candidates) {
    if (typeof value !== 'string') continue
    const path = value.trim()
    if (!path || !isAbsolute(path) || seen.has(path)) continue
    seen.add(path)
    unique.push(path)
  }
  return unique
}

function matchesProjectId(path: string, projectId: string): boolean {
  const normalizedPath = normalizePathKey(path)
  if (!normalizedPath) return false
  return opaqueScopeIdDeriverV1.deriveProject(normalizedPath).projectId === projectId
}

/**
 * Main-process-only adapter from opaque ProjectId to a verified local directory.
 * Raw paths never cross the public Task Hub boundary.
 */
export class MainProjectWorkspaceResolverV1 implements ProjectWorkspaceResolverV1 {
  private readonly source: ProjectWorkspaceCandidateSourceV1
  private readonly fileSystem: ProjectWorkspaceFileSystemV1

  constructor(options: MainProjectWorkspaceResolverOptionsV1 = {}) {
    this.source = options.source ?? configStoreCandidateSourceV1
    this.fileSystem = options.fileSystem ?? nodeFileSystemV1
  }

  async resolveProjectRoot(projectId: string): Promise<string> {
    if (typeof projectId !== 'string' || !projectId || projectId !== projectId.trim()) {
      throw new ProjectWorkspaceResolutionErrorV1('PROJECT_NOT_FOUND')
    }

    let snapshot: ProjectWorkspaceCandidatesV1
    try {
      snapshot = await this.source()
    } catch (error) {
      if (error instanceof ProjectWorkspaceResolutionErrorV1) throw error
      throw new ProjectWorkspaceResolutionErrorV1('PROJECT_PATH_UNAVAILABLE')
    }

    const matches = candidatePaths(snapshot).filter((path) => matchesProjectId(path, projectId))
    if (matches.length === 0) throw new ProjectWorkspaceResolutionErrorV1('PROJECT_NOT_FOUND')

    const realRoots = new Set<string>()
    for (const path of matches) {
      let realRoot: string
      try {
        realRoot = await this.fileSystem.realpath(path)
      } catch {
        throw new ProjectWorkspaceResolutionErrorV1('PROJECT_PATH_UNAVAILABLE')
      }

      try {
        if (!(await this.fileSystem.stat(realRoot)).isDirectory()) {
          throw new ProjectWorkspaceResolutionErrorV1('PROJECT_NOT_DIRECTORY')
        }
      } catch (error) {
        if (error instanceof ProjectWorkspaceResolutionErrorV1) throw error
        throw new ProjectWorkspaceResolutionErrorV1('PROJECT_PATH_UNAVAILABLE')
      }
      realRoots.add(realRoot)
    }

    if (realRoots.size !== 1) throw new ProjectWorkspaceResolutionErrorV1('PROJECT_AMBIGUOUS')
    return [...realRoots][0]
  }
}
