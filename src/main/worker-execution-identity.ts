import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { configStore } from './config-store'
import type { AgentRuntimeConfig } from './wsl/runtime-config'
import {
  projectRootComparisonKeyV2,
  readProjectRootIdentityV2,
} from './project-root-identity'
export { readProjectRootIdentityV2, type ProjectRootIdentityV2 } from './project-root-identity'

export interface WorkerResourceConfigIdentityV1 {
  readonly extensionOverrides: Readonly<Record<string, boolean>>
  readonly skillOverrides: Readonly<Record<string, boolean>>
  readonly skillPresentation: Readonly<Record<string, { alias?: string; icon?: string }>>
}

function compareKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Stable project-root identity used by Main before a Worker is reused. */
export function canonicalWorkerProjectRootV1(cwd: string): string {
  const lexical = resolve(String(cwd || '').trim())
  if (!existsSync(lexical)) return projectRootComparisonKeyV2(lexical)
  try {
    return projectRootComparisonKeyV2(realpathSync.native(lexical))
  } catch {
    return projectRootComparisonKeyV2(lexical)
  }
}

function sortedBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
      .sort(([left], [right]) => compareKey(left, right)),
  )
}

function sortedPresentationRecord(
  value: unknown,
): Record<string, { alias?: string; icon?: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries: Array<[string, { alias?: string; icon?: string }]> = []
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const presentation = raw as Record<string, unknown>
    const normalized: { alias?: string; icon?: string } = {}
    if (typeof presentation.alias === 'string') normalized.alias = presentation.alias
    if (typeof presentation.icon === 'string') normalized.icon = presentation.icon
    entries.push([key, normalized])
  }
  entries.sort(([left], [right]) => compareKey(left, right))
  return Object.fromEntries(entries)
}

export function readWorkerResourceConfigIdentityV1(): WorkerResourceConfigIdentityV1 {
  return {
    extensionOverrides: sortedBooleanRecord(configStore.get('extensionOverrides')),
    skillOverrides: sortedBooleanRecord(configStore.get('skillOverrides')),
    skillPresentation: sortedPresentationRecord(configStore.get('skillPresentation')),
  }
}

export function createWorkerExecutionIdentityDigestV1(input: {
  readonly cwd: string
  readonly runtime: AgentRuntimeConfig
  readonly resources: WorkerResourceConfigIdentityV1
  readonly projectRootIdentityDigest?: string
}): string {
  const payload = {
    schemaVersion: 2,
    projectRoot: canonicalWorkerProjectRootV1(input.cwd),
    projectRootIdentityDigest: input.projectRootIdentityDigest
      ?? `path-only:${canonicalWorkerProjectRootV1(input.cwd)}`,
    runtime: {
      mode: input.runtime.mode,
      distro: input.runtime.mode === 'wsl' ? input.runtime.distro : null,
    },
    resources: {
      extensionOverrides: sortedBooleanRecord(input.resources.extensionOverrides),
      skillOverrides: sortedBooleanRecord(input.resources.skillOverrides),
      skillPresentation: sortedPresentationRecord(input.resources.skillPresentation),
    },
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
}

export function readCurrentWorkerExecutionIdentityDigestV1(
  cwd: string,
  runtime: AgentRuntimeConfig,
): string {
  return createWorkerExecutionIdentityDigestV1({
    cwd,
    runtime,
    resources: readWorkerResourceConfigIdentityV1(),
    projectRootIdentityDigest: readProjectRootIdentityV2(cwd).digest,
  })
}
