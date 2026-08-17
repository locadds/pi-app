import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1 } from './acp/kimi-tool-policy'
import { KimiProductionHomeError, prepareKimiProductionHomeV1 } from './kimi-production-home'

const roots: string[] = []
const KIMI_PRODUCTION_CONFIG_V1 = '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function userDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-kimi-production-home-'))
  roots.push(root)
  return root
}

describe('prepareKimiProductionHomeV1', () => {
  it('keeps the managed Kimi home absent when production is disabled', () => {
    const root = userDataDir()
    const kimiCodeHome = join(root, 'xiaogui', 'agent-runtime', 'kimi-v1')

    expect(prepareKimiProductionHomeV1({ enabled: false, userDataDir: root })).toEqual({ enabled: false })
    expect(existsSync(kimiCodeHome)).toBe(false)
  })

  it('creates the absolute private Kimi home with the fixed tool policy and agent profile', () => {
    const root = userDataDir()
    const kimiCodeHome = join(root, 'xiaogui', 'agent-runtime', 'kimi-v1')

    expect(prepareKimiProductionHomeV1({ enabled: true, userDataDir: root })).toEqual({
      enabled: true,
      kimiCodeHome,
    })
    expect(isAbsolute(kimiCodeHome)).toBe(true)
    expect(readFileSync(join(kimiCodeHome, 'config.toml'), 'utf8')).toBe(KIMI_PRODUCTION_CONFIG_V1)
    expect(readFileSync(join(kimiCodeHome, 'agents', 'agent.md'), 'utf8')).toBe(KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1)
  })

  it('replays without rewriting matching managed files and rejects managed profile drift', () => {
    const root = userDataDir()
    const prepared = prepareKimiProductionHomeV1({ enabled: true, userDataDir: root })
    if (!prepared.enabled) throw new Error('managed Kimi home was not enabled')
    const configPath = join(prepared.kimiCodeHome, 'config.toml')
    const profilePath = join(prepared.kimiCodeHome, 'agents', 'agent.md')
    const stableTime = new Date('2001-02-03T04:05:06.000Z')
    utimesSync(configPath, stableTime, stableTime)
    utimesSync(profilePath, stableTime, stableTime)
    const configMtimeMs = statSync(configPath).mtimeMs
    const profileMtimeMs = statSync(profilePath).mtimeMs

    expect(prepareKimiProductionHomeV1({ enabled: true, userDataDir: root })).toEqual(prepared)
    expect(statSync(configPath).mtimeMs).toBe(configMtimeMs)
    expect(statSync(profilePath).mtimeMs).toBe(profileMtimeMs)

    writeFileSync(profilePath, `${KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1}drift`)
    let driftError: unknown
    try {
      prepareKimiProductionHomeV1({ enabled: true, userDataDir: root })
    } catch (error) {
      driftError = error
    }
    expect(driftError).toBeInstanceOf(KimiProductionHomeError)
    expect(driftError).toMatchObject({ reasonCode: 'KIMI_PRODUCTION_HOME_POLICY_DRIFT' })
  })

  it('rejects an aliased managed parent before writing into its external target', () => {
    const externalRoot = userDataDir()
    const root = userDataDir()
    const managedParent = join(root, 'xiaogui', 'agent-runtime')
    mkdirSync(join(root, 'xiaogui'), { recursive: true })
    symlinkSync(externalRoot, managedParent, process.platform === 'win32' ? 'junction' : 'dir')

    let aliasError: unknown
    try {
      prepareKimiProductionHomeV1({ enabled: true, userDataDir: root })
    } catch (error) {
      aliasError = error
    }

    expect(aliasError).toBeInstanceOf(KimiProductionHomeError)
    expect(existsSync(join(externalRoot, 'kimi-v1'))).toBe(false)
    expect(existsSync(join(externalRoot, 'kimi-v1', 'agents'))).toBe(false)
  })
})
