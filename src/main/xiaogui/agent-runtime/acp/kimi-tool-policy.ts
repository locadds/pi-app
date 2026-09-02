import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const KIMI_ACP_APPROVED_VERSION_V1 = '0.34.0'
export const KIMI_ACP_ENGINE_V1 = 'legacy-sdk-acp'
export const KIMI_ACP_TOOL_ALLOWLIST_V1 = ['Read', 'Write', 'Edit', 'TodoList'] as const
export const KIMI_ACP_LEGACY_AGENT_PROFILE_NAME_V1 = 'agent'
export const KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1 = [
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
].join('\n')
export const KIMI_ACP_LEGACY_AGENT_PROFILE_DIGEST_V1 = digestText(KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1)
export const KIMI_ACP_TOOL_POLICY_DIGEST_V1 = digestJson({
  domain: 'xiaogui.kimi-acp.tool-policy.v1',
  engine: KIMI_ACP_ENGINE_V1,
  version: KIMI_ACP_APPROVED_VERSION_V1,
  enabled: KIMI_ACP_TOOL_ALLOWLIST_V1,
  profileDigest: KIMI_ACP_LEGACY_AGENT_PROFILE_DIGEST_V1,
})

export interface PreparedKimiAcpToolPolicyV1 {
  readonly kimiCodeHome: string
  readonly env: Readonly<Record<string, string>>
  readonly policyDigest: string
  revalidateBeforeSpawn(): void
}

/**
 * Validates the mutable Kimi config without requiring byte-for-byte equality.
 * `kimi login` legitimately adds provider/model/credential sections, while the
 * product-owned tool allowlist and agent-directory boundary remain immutable.
 */
export function validateKimiAcpConfigContentV1(config: string): void {
  validateEnabledTools(parseEnabledTools(config))
  validateNoExtraAgentDirs(config)
}

interface KimiToolFileIdentityV1 {
  readonly realPath: string
  readonly dev: bigint
  readonly ino: bigint
  readonly contentDigest: string
  readonly content: string
}

export class KimiAcpToolPolicyError extends Error {
  readonly reasonCode: string

  constructor(reasonCode: string) {
    super(reasonCode)
    this.name = 'KimiAcpToolPolicyError'
    this.reasonCode = reasonCode
  }
}

export function prepareKimiAcpToolPolicyV1(kimiCodeHome: string | undefined, workspaceRoot: string): PreparedKimiAcpToolPolicyV1 {
  if (!kimiCodeHome) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_HOME_MISSING')
  if (!isAbsolute(kimiCodeHome)) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_HOME_NOT_ABSOLUTE')
  const lexicalHome = resolve(kimiCodeHome)
  const realHome = safeRealpath(lexicalHome, 'KIMI_TOOL_POLICY_HOME_MISSING')
  if (pathKey(lexicalHome) !== pathKey(realHome)) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_HOME_ALIAS')
  assertDirectory(realHome)
  const realWorkspaceRoot = resolveWorkspaceRoot(workspaceRoot)
  assertNoProjectAgentOverride(realWorkspaceRoot)

  const configPath = join(realHome, 'config.toml')
  const configIdentity = readIdentity(configPath, {
    missing: 'KIMI_TOOL_POLICY_CONFIG_MISSING',
    alias: 'KIMI_TOOL_POLICY_CONFIG_ALIAS',
    notFile: 'KIMI_TOOL_POLICY_CONFIG_NOT_FILE',
    hardlink: 'KIMI_TOOL_POLICY_CONFIG_HARDLINK',
  })
  validateKimiAcpConfigContentV1(configIdentity.content)

  const profilePath = join(realHome, 'agents', `${KIMI_ACP_LEGACY_AGENT_PROFILE_NAME_V1}.md`)
  const profileIdentity = readIdentity(profilePath, {
    missing: 'KIMI_TOOL_POLICY_AGENT_PROFILE_MISSING',
    alias: 'KIMI_TOOL_POLICY_AGENT_PROFILE_ALIAS',
    notFile: 'KIMI_TOOL_POLICY_AGENT_PROFILE_NOT_FILE',
    hardlink: 'KIMI_TOOL_POLICY_AGENT_PROFILE_HARDLINK',
  })
  if (profileIdentity.content !== KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_AGENT_PROFILE_CONTENT_MISMATCH')

  return {
    kimiCodeHome: realHome,
    env: {
      KIMI_CODE_HOME: realHome,
      KIMI_CODE_LEGACY_FLAG: '1',
      HOME: realHome,
      USERPROFILE: realHome,
    },
    policyDigest: KIMI_ACP_TOOL_POLICY_DIGEST_V1,
    revalidateBeforeSpawn() {
      assertNoProjectAgentOverride(realWorkspaceRoot)
      const current = readIdentity(configPath, {
        missing: 'KIMI_TOOL_POLICY_CONFIG_MISSING',
        alias: 'KIMI_TOOL_POLICY_CONFIG_ALIAS',
        notFile: 'KIMI_TOOL_POLICY_CONFIG_NOT_FILE',
        hardlink: 'KIMI_TOOL_POLICY_CONFIG_HARDLINK',
      })
      if (pathKey(current.realPath) !== pathKey(configIdentity.realPath) || current.dev !== configIdentity.dev || current.ino !== configIdentity.ino) {
        throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_CONFIG_IDENTITY_CHANGED')
      }
      if (current.contentDigest !== configIdentity.contentDigest) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_CONFIG_CONTENT_CHANGED')
      validateKimiAcpConfigContentV1(current.content)
      const currentProfile = readIdentity(profilePath, {
        missing: 'KIMI_TOOL_POLICY_AGENT_PROFILE_MISSING',
        alias: 'KIMI_TOOL_POLICY_AGENT_PROFILE_ALIAS',
        notFile: 'KIMI_TOOL_POLICY_AGENT_PROFILE_NOT_FILE',
        hardlink: 'KIMI_TOOL_POLICY_AGENT_PROFILE_HARDLINK',
      })
      if (pathKey(currentProfile.realPath) !== pathKey(profileIdentity.realPath) || currentProfile.dev !== profileIdentity.dev || currentProfile.ino !== profileIdentity.ino) {
        throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_AGENT_PROFILE_IDENTITY_CHANGED')
      }
      if (currentProfile.contentDigest !== profileIdentity.contentDigest) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_AGENT_PROFILE_CONTENT_CHANGED')
      if (currentProfile.content !== KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_AGENT_PROFILE_CONTENT_MISMATCH')
    },
  }
}

function assertDirectory(path: string): void {
  let info
  try {
    info = lstatSync(path, { bigint: true })
  } catch {
    throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_HOME_MISSING')
  }
  if (info.isSymbolicLink()) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_HOME_ALIAS')
  if (!info.isDirectory()) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_HOME_NOT_DIRECTORY')
}

function resolveWorkspaceRoot(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_WORKSPACE_ROOT_NOT_ABSOLUTE')
  return safeRealpath(resolve(workspaceRoot), 'KIMI_TOOL_POLICY_WORKSPACE_ROOT_MISSING')
}

function assertNoProjectAgentOverride(workspaceRoot: string): void {
  for (const relativePath of [join('.kimi-code', 'agents'), join('.agents', 'agents')]) {
    const candidate = join(workspaceRoot, relativePath)
    try {
      lstatSync(candidate)
      throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_PROJECT_AGENT_OVERRIDE_PRESENT')
    } catch (error) {
      if (error instanceof KimiAcpToolPolicyError) throw error
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_PROJECT_AGENT_OVERRIDE_PRESENT')
    }
  }
}

function readIdentity(configPath: string, reasons: { missing: string; alias: string; notFile: string; hardlink: string }): KimiToolFileIdentityV1 {
  let info
  try {
    info = lstatSync(configPath, { bigint: true })
  } catch {
    throw new KimiAcpToolPolicyError(reasons.missing)
  }
  if (info.isSymbolicLink()) throw new KimiAcpToolPolicyError(reasons.alias)
  if (!info.isFile()) throw new KimiAcpToolPolicyError(reasons.notFile)
  if (info.nlink !== 1n) throw new KimiAcpToolPolicyError(reasons.hardlink)
  const realConfig = safeRealpath(configPath, reasons.missing)
  if (pathKey(configPath) !== pathKey(realConfig)) throw new KimiAcpToolPolicyError(reasons.alias)
  const content = readFileSync(realConfig, 'utf8')
  return {
    realPath: realConfig,
    dev: info.dev,
    ino: info.ino,
    contentDigest: digestText(content),
    content,
  }
}

function parseEnabledTools(config: string): string[] {
  let inTools = false
  let toolsSections = 0
  let enabled: string[] | null = null

  for (const rawLine of config.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue
    const section = line.match(/^\[([A-Za-z0-9_.-]+)\]$/)
    if (section) {
      inTools = section[1] === 'tools'
      if (inTools) toolsSections += 1
      if (toolsSections > 1) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_TOOLS_SECTION_DUPLICATE')
      continue
    }
    if (!inTools) continue
    const match = line.match(/^enabled\s*=\s*\[(.*)\]$/)
    if (!match) continue
    if (enabled) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_ENABLED_DUPLICATE')
    enabled = parseStringArray(match[1])
  }

  if (toolsSections === 0) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_TOOLS_SECTION_MISSING')
  if (!enabled) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_ENABLED_MISSING')
  return enabled
}

function validateNoExtraAgentDirs(config: string): void {
  for (const rawLine of config.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (/^(?:extra_agent_dirs|"extra_agent_dirs"|'extra_agent_dirs')\s*=/.test(line)) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_EXTRA_AGENT_DIRS_FORBIDDEN')
  }
}

function parseStringArray(value: string): string[] {
  const result: string[] = []
  const trimmed = value.trim()
  if (!trimmed) return result
  for (const part of trimmed.split(',')) {
    const match = part.trim().match(/^"([^"]+)"$/)
    if (!match) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_ENABLED_INVALID')
    result.push(match[1])
  }
  return result
}

function validateEnabledTools(enabled: readonly string[]): void {
  if (new Set(enabled).size !== enabled.length) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_TOOL_DUPLICATE')
  const required = new Set<string>(KIMI_ACP_TOOL_ALLOWLIST_V1)
  for (const tool of enabled) {
    if (!required.has(tool)) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_TOOL_FORBIDDEN')
  }
  for (const tool of required) {
    if (!enabled.includes(tool)) throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_ALLOWLIST_INCOMPLETE')
  }
  if (enabled.some((tool, index) => tool !== KIMI_ACP_TOOL_ALLOWLIST_V1[index])) {
    throw new KimiAcpToolPolicyError('KIMI_TOOL_POLICY_ALLOWLIST_DRIFT')
  }
}

function stripComment(line: string): string {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') quoted = !quoted
    if (!quoted && char === '#') return line.slice(0, index)
  }
  return line
}

function safeRealpath(path: string, reasonCode: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    throw new KimiAcpToolPolicyError(reasonCode)
  }
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
