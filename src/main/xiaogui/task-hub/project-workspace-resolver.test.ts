import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { opaqueScopeIdDeriverV1 } from '../scope-derive'
import {
  MainProjectWorkspaceResolverV1,
  ProjectWorkspaceResolutionErrorV1,
  type ProjectWorkspaceCandidatesV1,
} from './project-workspace-resolver'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function projectId(path: string): string {
  return opaqueScopeIdDeriverV1.deriveProject(path).projectId
}

function resolver(snapshot: ProjectWorkspaceCandidatesV1): MainProjectWorkspaceResolverV1 {
  return new MainProjectWorkspaceResolverV1({ source: () => snapshot })
}

describe('MainProjectWorkspaceResolverV1', () => {
  it('resolves the matching current project to its real directory', async () => {
    const currentProject = await tempRoot('xiaogui-current-project-')

    await expect(resolver({ currentProject, recentProjects: [] }).resolveProjectRoot(projectId(currentProject)))
      .resolves.toBe(await realpath(currentProject))
  })

  it('resolves a matching recent project when current project does not match', async () => {
    const currentProject = await tempRoot('xiaogui-current-other-')
    const recentProject = await tempRoot('xiaogui-recent-project-')

    await expect(
      resolver({ currentProject, recentProjects: [recentProject] }).resolveProjectRoot(projectId(recentProject)),
    ).resolves.toBe(await realpath(recentProject))
  })

  it('fails closed when no candidate derives the requested ProjectId', async () => {
    const currentProject = await tempRoot('xiaogui-current-miss-')

    await expect(
      resolver({ currentProject, recentProjects: [] }).resolveProjectRoot(projectId(`${currentProject}-other`)),
    ).rejects.toEqual(new ProjectWorkspaceResolutionErrorV1('PROJECT_NOT_FOUND'))
  })

  it('fails closed when one ProjectId maps to multiple real roots', async () => {
    const upper = '/CaseSensitive/Project'
    const lower = '/casesensitive/project'
    const subject = new MainProjectWorkspaceResolverV1({
      source: () => ({ currentProject: upper, recentProjects: [upper, lower] }),
      fileSystem: {
        realpath: async (path) => path === upper ? '/real/root-one' : '/real/root-two',
        stat: async () => ({ isDirectory: () => true }),
      },
    })

    await expect(subject.resolveProjectRoot(projectId(upper)))
      .rejects.toEqual(new ProjectWorkspaceResolutionErrorV1('PROJECT_AMBIGUOUS'))
  })

  it('fails closed when the matching path is unavailable', async () => {
    const missing = join(tmpdir(), `xiaogui-missing-project-${process.pid}-${Date.now()}`)

    await expect(resolver({ currentProject: missing, recentProjects: [] }).resolveProjectRoot(projectId(missing)))
      .rejects.toEqual(new ProjectWorkspaceResolutionErrorV1('PROJECT_PATH_UNAVAILABLE'))
  })

  it('fails closed when the matching path is not a directory', async () => {
    const root = await tempRoot('xiaogui-project-file-')
    const file = join(root, 'not-a-directory.txt')
    await writeFile(file, 'x')

    await expect(resolver({ currentProject: file, recentProjects: [] }).resolveProjectRoot(projectId(file)))
      .rejects.toEqual(new ProjectWorkspaceResolutionErrorV1('PROJECT_NOT_DIRECTORY'))
  })
})
