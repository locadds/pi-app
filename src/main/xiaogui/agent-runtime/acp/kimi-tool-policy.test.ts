import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { NdjsonAcpProcessTransportV1 } from './process-transport'
import type { AcpTransportStartOptionsV1 } from './types'
import {
  KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1,
  KIMI_ACP_LEGACY_AGENT_PROFILE_DIGEST_V1,
  KIMI_ACP_TOOL_POLICY_DIGEST_V1,
  KimiAcpToolPolicyError,
  prepareKimiAcpToolPolicyV1,
} from './kimi-tool-policy'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
  }
})

function kimiHome(config: string | null = 'enabled = ["Read", "Write", "Edit", "TodoList"]\n') {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-kimi-home-'))
  roots.push(root)
  if (config !== null) writeFileSync(join(root, 'config.toml'), `[tools]\n${config}`)
  mkdirSync(join(root, 'agents'))
  writeFileSync(join(root, 'agents', 'agent.md'), KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1)
  return root
}

function workspaceRoot() {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-workspace-'))
  roots.push(root)
  return root
}

function expectPolicyFailure(homePath: string | undefined, reasonCode: string, root = workspaceRoot()) {
  expect(() => prepareKimiAcpToolPolicyV1(homePath, root)).toThrow(KimiAcpToolPolicyError)
  try {
    prepareKimiAcpToolPolicyV1(homePath, root)
  } catch (error) {
    expect(error).toMatchObject({ reasonCode })
  }
}

function startOptions(onDisconnect: (reasonCode: string) => void): AcpTransportStartOptionsV1 {
  return {
    cwd: process.cwd(),
    initialize: {
      protocolVersion: 1,
      clientInfo: { name: 'xiaogui-test', version: '0.0.0' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    },
    requestHandlers: new Map(),
    onSessionUpdate() {},
    async onPermissionRequest() {
      return { outcome: { outcome: 'cancelled' } }
    },
    onDisconnect,
  }
}

describe('Kimi ACP tool policy', () => {
  it('validates an isolated KIMI_CODE_HOME with the fixed safe tool allowlist', () => {
    const home = kimiHome()
    const policy = prepareKimiAcpToolPolicyV1(home, workspaceRoot())
    expect(KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1).toBe([
      '---',
      'name: agent',
      'description: Xiaogui controlled ACP coding agent',
      'override: true',
      'tools:',
      '  - Read',
      '  - Write',
      '  - Edit',
      '  - TodoList',
      'disallowedTools:',
      '  - Bash',
      'subagents: []',
      '---',
      '',
      '${base_prompt}',
      '',
    ].join('\n'))
    expect(KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1).toContain('description: Xiaogui controlled ACP coding agent')
    expect(KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1).toContain('disallowedTools:')
    expect(KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1).not.toContain('disallowed_tools:')
    expect(KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1).toContain('---\n\n${base_prompt}\n')
    expect(policy).toMatchObject({
      kimiCodeHome: resolve(home),
      env: {
        KIMI_CODE_HOME: resolve(home),
        KIMI_CODE_LEGACY_FLAG: '1',
        HOME: resolve(home),
        USERPROFILE: resolve(home),
      },
      policyDigest: KIMI_ACP_TOOL_POLICY_DIGEST_V1,
    })
    expect(KIMI_ACP_LEGACY_AGENT_PROFILE_DIGEST_V1).toMatch(/^sha256:/)
    expect(policy.revalidateBeforeSpawn).toEqual(expect.any(Function))
  })

  it('fails closed for missing, relative, aliased, missing config, duplicate, drifted, extra, unknown, or incomplete tool policies', () => {
    expectPolicyFailure(undefined, 'KIMI_TOOL_POLICY_HOME_MISSING')
    expectPolicyFailure('relative-home', 'KIMI_TOOL_POLICY_HOME_NOT_ABSOLUTE')
    expectPolicyFailure(kimiHome(null), 'KIMI_TOOL_POLICY_CONFIG_MISSING')
    expectPolicyFailure(kimiHome('[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n'), 'KIMI_TOOL_POLICY_TOOLS_SECTION_DUPLICATE')
    expectPolicyFailure(kimiHome('enabled = ["TodoList", "Edit", "Write", "Read"]\n'), 'KIMI_TOOL_POLICY_ALLOWLIST_DRIFT')
    expectPolicyFailure(kimiHome('enabled = ["Read", "Write", "Edit", "TodoList", "Bash"]\n'), 'KIMI_TOOL_POLICY_TOOL_FORBIDDEN')
    expectPolicyFailure(kimiHome('enabled = ["Read", "Write", "Edit", "TodoList", "FutureTool"]\n'), 'KIMI_TOOL_POLICY_TOOL_FORBIDDEN')
    expectPolicyFailure(kimiHome('enabled = ["Read", "Write", "Edit"]\n'), 'KIMI_TOOL_POLICY_ALLOWLIST_INCOMPLETE')
    expectPolicyFailure(kimiHome('enabled = ["Read", "Write", "Edit", "TodoList", "Read"]\n'), 'KIMI_TOOL_POLICY_TOOL_DUPLICATE')
    expectPolicyFailure(kimiHome('extra_agent_dirs = ["../agents"]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n'), 'KIMI_TOOL_POLICY_EXTRA_AGENT_DIRS_FORBIDDEN')
    expectPolicyFailure(kimiHome('"extra_agent_dirs" = ["../agents"]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n'), 'KIMI_TOOL_POLICY_EXTRA_AGENT_DIRS_FORBIDDEN')
    expectPolicyFailure(kimiHome("'extra_agent_dirs' = ['../agents']\nenabled = [\"Read\", \"Write\", \"Edit\", \"TodoList\"]\n"), 'KIMI_TOOL_POLICY_EXTRA_AGENT_DIRS_FORBIDDEN')

    const symlinkTarget = kimiHome()
    const symlinkHome = join(tmpdir(), `xiaogui-kimi-home-link-${process.pid}-${Date.now()}`)
    let symlinkHomeCreated = false
    try {
      symlinkSync(symlinkTarget, symlinkHome, 'dir')
      symlinkHomeCreated = true
      roots.push(symlinkHome)
    } catch {
      // Windows developer mode may be disabled; the non-symlink matrix above remains deterministic.
    }
    if (symlinkHomeCreated) expectPolicyFailure(symlinkHome, 'KIMI_TOOL_POLICY_HOME_ALIAS')
  })

  it('fails closed for unsafe config identity and invalid enabled arrays', () => {
    const configSymlinkHome = kimiHome(null)
    const configSymlinkTarget = join(configSymlinkHome, 'config-target.toml')
    writeFileSync(configSymlinkTarget, '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n')
    let configSymlinkCreated = false
    try {
      symlinkSync(configSymlinkTarget, join(configSymlinkHome, 'config.toml'))
      configSymlinkCreated = true
    } catch {
      // Windows developer mode may be disabled; hardlink and non-file cases still cover config identity checks.
    }
    if (configSymlinkCreated) expectPolicyFailure(configSymlinkHome, 'KIMI_TOOL_POLICY_CONFIG_ALIAS')

    const hardlinkHome = kimiHome(null)
    const hardlinkTarget = join(hardlinkHome, 'config-target.toml')
    writeFileSync(hardlinkTarget, '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n')
    let hardlinkCreated = false
    try {
      linkSync(hardlinkTarget, join(hardlinkHome, 'config.toml'))
      hardlinkCreated = true
    } catch {
      // Some filesystems deny hardlinks; the other matrix entries remain deterministic.
    }
    if (hardlinkCreated) expectPolicyFailure(hardlinkHome, 'KIMI_TOOL_POLICY_CONFIG_HARDLINK')

    const nonFileHome = kimiHome(null)
    mkdirSync(join(nonFileHome, 'config.toml'))
    expectPolicyFailure(nonFileHome, 'KIMI_TOOL_POLICY_CONFIG_NOT_FILE')

    expectPolicyFailure(kimiHome('enabled = ["Read", "Write", "Edit", "TodoList"]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n'), 'KIMI_TOOL_POLICY_ENABLED_DUPLICATE')
    expectPolicyFailure(kimiHome('enabled = [Read, "Write", "Edit", "TodoList"]\n'), 'KIMI_TOOL_POLICY_ENABLED_INVALID')
  })

  it('fails closed for missing or unsafe canonical legacy agent profile files', () => {
    const missingHome = kimiHome()
    unlinkSync(join(missingHome, 'agents', 'agent.md'))
    expectPolicyFailure(missingHome, 'KIMI_TOOL_POLICY_AGENT_PROFILE_MISSING')

    const contentHome = kimiHome()
    writeFileSync(join(contentHome, 'agents', 'agent.md'), `${KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1}drift`)
    expectPolicyFailure(contentHome, 'KIMI_TOOL_POLICY_AGENT_PROFILE_CONTENT_MISMATCH')

    const nonFileHome = kimiHome()
    unlinkSync(join(nonFileHome, 'agents', 'agent.md'))
    mkdirSync(join(nonFileHome, 'agents', 'agent.md'))
    expectPolicyFailure(nonFileHome, 'KIMI_TOOL_POLICY_AGENT_PROFILE_NOT_FILE')

    const symlinkHome = kimiHome()
    unlinkSync(join(symlinkHome, 'agents', 'agent.md'))
    const symlinkTarget = join(symlinkHome, 'agent-target.md')
    writeFileSync(symlinkTarget, KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1)
    let symlinkCreated = false
    try {
      symlinkSync(symlinkTarget, join(symlinkHome, 'agents', 'agent.md'))
      symlinkCreated = true
    } catch {
      // Windows developer mode may be disabled; hardlink and non-file cases remain deterministic.
    }
    if (symlinkCreated) expectPolicyFailure(symlinkHome, 'KIMI_TOOL_POLICY_AGENT_PROFILE_ALIAS')

    const hardlinkHome = kimiHome()
    unlinkSync(join(hardlinkHome, 'agents', 'agent.md'))
    const hardlinkTarget = join(hardlinkHome, 'agent-target.md')
    writeFileSync(hardlinkTarget, KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1)
    let hardlinkCreated = false
    try {
      linkSync(hardlinkTarget, join(hardlinkHome, 'agents', 'agent.md'))
      hardlinkCreated = true
    } catch {
      // Some filesystems deny hardlinks; the other profile matrix entries remain deterministic.
    }
    if (hardlinkCreated) expectPolicyFailure(hardlinkHome, 'KIMI_TOOL_POLICY_AGENT_PROFILE_HARDLINK')
  })

  it('fails closed when project-level agent override directories exist in the workspace', () => {
    const kimiCodeHome = kimiHome()
    const dotKimiWorkspace = workspaceRoot()
    mkdirSync(join(dotKimiWorkspace, '.kimi-code', 'agents'), { recursive: true })
    expectPolicyFailure(kimiCodeHome, 'KIMI_TOOL_POLICY_PROJECT_AGENT_OVERRIDE_PRESENT', dotKimiWorkspace)

    const dotAgentsWorkspace = workspaceRoot()
    mkdirSync(join(dotAgentsWorkspace, '.agents', 'agents'), { recursive: true })
    expectPolicyFailure(kimiCodeHome, 'KIMI_TOOL_POLICY_PROJECT_AGENT_OVERRIDE_PRESENT', dotAgentsWorkspace)

    const fileWorkspace = workspaceRoot()
    mkdirSync(join(fileWorkspace, '.agents'), { recursive: true })
    writeFileSync(join(fileWorkspace, '.agents', 'agents'), 'not a directory')
    expectPolicyFailure(kimiCodeHome, 'KIMI_TOOL_POLICY_PROJECT_AGENT_OVERRIDE_PRESENT', fileWorkspace)

    const danglingSymlinkWorkspace = workspaceRoot()
    mkdirSync(join(danglingSymlinkWorkspace, '.kimi-code'), { recursive: true })
    let danglingSymlinkCreated = false
    try {
      symlinkSync(join(danglingSymlinkWorkspace, 'missing-target'), join(danglingSymlinkWorkspace, '.kimi-code', 'agents'), 'dir')
      danglingSymlinkCreated = true
    } catch {
      // Windows developer mode may be disabled; file and directory entries remain deterministic.
    }
    if (danglingSymlinkCreated) expectPolicyFailure(kimiCodeHome, 'KIMI_TOOL_POLICY_PROJECT_AGENT_OVERRIDE_PRESENT', danglingSymlinkWorkspace)
  })

  it('revalidates the trusted private profile identity and content immediately before spawn', () => {
    const contentDriftHome = kimiHome()
    const contentPolicy = prepareKimiAcpToolPolicyV1(contentDriftHome, workspaceRoot())
    writeFileSync(join(contentDriftHome, 'config.toml'), '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList", "Bash"]\n')
    expect(() => contentPolicy.revalidateBeforeSpawn()).toThrow(KimiAcpToolPolicyError)
    try {
      contentPolicy.revalidateBeforeSpawn()
    } catch (error) {
      expect(error).toMatchObject({ reasonCode: 'KIMI_TOOL_POLICY_CONFIG_CONTENT_CHANGED' })
    }

    const identityDriftHome = kimiHome()
    const identityPolicy = prepareKimiAcpToolPolicyV1(identityDriftHome, workspaceRoot())
    unlinkSync(join(identityDriftHome, 'config.toml'))
    writeFileSync(join(identityDriftHome, 'config.toml'), '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n')
    expect(() => identityPolicy.revalidateBeforeSpawn()).toThrow(KimiAcpToolPolicyError)
    try {
      identityPolicy.revalidateBeforeSpawn()
    } catch (error) {
      expect(error).toMatchObject({ reasonCode: 'KIMI_TOOL_POLICY_CONFIG_IDENTITY_CHANGED' })
    }

    const profileDriftHome = kimiHome()
    const profilePolicy = prepareKimiAcpToolPolicyV1(profileDriftHome, workspaceRoot())
    writeFileSync(join(profileDriftHome, 'agents', 'agent.md'), `${KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1}drift`)
    expect(() => profilePolicy.revalidateBeforeSpawn()).toThrow(KimiAcpToolPolicyError)
    try {
      profilePolicy.revalidateBeforeSpawn()
    } catch (error) {
      expect(error).toMatchObject({ reasonCode: 'KIMI_TOOL_POLICY_AGENT_PROFILE_CONTENT_CHANGED' })
    }

    const overrideWorkspace = workspaceRoot()
    const overridePolicy = prepareKimiAcpToolPolicyV1(kimiHome(), overrideWorkspace)
    mkdirSync(join(overrideWorkspace, '.kimi-code', 'agents'), { recursive: true })
    expect(() => overridePolicy.revalidateBeforeSpawn()).toThrow(KimiAcpToolPolicyError)
    try {
      overridePolicy.revalidateBeforeSpawn()
    } catch (error) {
      expect(error).toMatchObject({ reasonCode: 'KIMI_TOOL_POLICY_PROJECT_AGENT_OVERRIDE_PRESENT' })
    }
  })
})

describe('NDJSON ACP process transport pipe closure', () => {
  it('fails pending calls once when child stdin closes before a request can be written', async () => {
    const script = [
      "let input = '';",
      "process.stdin.on('data', (chunk) => {",
      "  input += chunk.toString('utf8');",
      "  let index;",
      "  while ((index = input.indexOf('\\n')) >= 0) {",
      "    const line = input.slice(0, index).trim();",
      "    input = input.slice(index + 1);",
      "    if (!line) continue;",
      "    const message = JSON.parse(line);",
      "    if (message.method === 'initialize') {",
      "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }) + '\\n', () => process.stdin.destroy());",
      "    }",
      "  }",
      "});",
      "setTimeout(() => {}, 5000);",
    ].join('')
    const reasons: string[] = []
    const transport = new NdjsonAcpProcessTransportV1(process.execPath, ['-e', script], process.cwd())

    await expect(transport.start(startOptions((reasonCode) => reasons.push(reasonCode)))).resolves.toMatchObject({ protocolVersion: 1 })
    const internals = transport as unknown as { child?: { stdin?: { destroy(): void } } }
    internals.child?.stdin?.destroy()
    await expect(transport.newSession(process.cwd())).rejects.toThrow('PROCESS_STDIN_CLOSED')
    expect(reasons).toEqual(['PROCESS_STDIN_CLOSED'])
    await transport.dispose()
    expect(reasons).toEqual(['PROCESS_STDIN_CLOSED'])
  })

  it('reports process error and close only once', async () => {
    const reasons: string[] = []
    const transport = new NdjsonAcpProcessTransportV1('__xiaogui_missing_executable__', [], process.cwd())

    await expect(transport.start(startOptions((reasonCode) => reasons.push(reasonCode)))).rejects.toThrow()
    expect(reasons).toEqual(['PROCESS_ERROR'])
    await transport.dispose()
    expect(reasons).toEqual(['PROCESS_ERROR'])
  })

  it('rejects calls immediately after the transport is already closed', async () => {
    const transport = new NdjsonAcpProcessTransportV1(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], process.cwd())
    await transport.dispose()
    const startedAt = Date.now()

    await expect(transport.newSession(process.cwd())).rejects.toThrow('DISPOSED')
    expect(Date.now() - startedAt).toBeLessThan(1000)
  })

  it('runs trusted preSpawn validation before spawning the child process', async () => {
    const proofPath = join(kimiHome(null), 'spawn-proof.txt')
    const reasons: string[] = []
    const transport = new NdjsonAcpProcessTransportV1(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(proofPath)}, 'spawned')`],
      process.cwd(),
      {
        preSpawn() {
          throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_CONFIG_CONTENT_CHANGED')
        },
      },
    )

    await expect(transport.start(startOptions((reasonCode) => reasons.push(reasonCode)))).rejects.toThrow('KIMI_TOOL_POLICY_CONFIG_CONTENT_CHANGED')
    expect(reasons).toEqual(['KIMI_TOOL_POLICY_CONFIG_CONTENT_CHANGED'])
    expect(existsSync(proofPath)).toBe(false)
  })
})
