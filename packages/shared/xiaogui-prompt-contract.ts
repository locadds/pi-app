export const XIAOGUI_PROMPT_CONTRACT_ID_V1 = 'xiaogui.prompt-contract.v1' as const
export const XIAOGUI_PROMPT_CONTRACT_SCHEMA_VERSION_V1 = 1 as const
export const XIAOGUI_PROMPT_CONTRACT_VERSION_V1 = '1.0.0' as const

export const XIAOGUI_PROMPT_MODES_V1 = ['WORK', 'DESIGN', 'CODING'] as const
export type XiaoguiMode = (typeof XIAOGUI_PROMPT_MODES_V1)[number]

export const XIAOGUI_PROMPT_PHASES_V1 = ['ASK', 'PLAN', 'EXECUTE'] as const
export type XiaoguiExecutionPhase = (typeof XIAOGUI_PROMPT_PHASES_V1)[number]

/**
 * New conversations are ready for controlled execution by default. ASK and PLAN
 * remain explicit user-selected modes; safety still comes from tool, permission,
 * worktree and delivery gates rather than a mandatory read-only first turn.
 */
export const XIAOGUI_DEFAULT_EXECUTION_PHASE_V1 = 'EXECUTE' as const satisfies XiaoguiExecutionPhase

export const XIAOGUI_CAPABILITY_IDS_V1 = [
  'collaboration.execution',
  'work.file-organize',
  'work.report-docx',
  'work.template-intake',
  'work.template-generation',
  'design.analysis',
  'coding.workspace',
] as const
export type XiaoguiCapabilityId = (typeof XIAOGUI_CAPABILITY_IDS_V1)[number]

export const XIAOGUI_PROMPT_LAYER_KINDS_V1 = [
  'BASE',
  'MODE',
  'PHASE',
  'CAPABILITY',
  'RUNTIME',
] as const
export type XiaoguiPromptLayerKindV1 = (typeof XIAOGUI_PROMPT_LAYER_KINDS_V1)[number]

/**
 * Session-scoped selection facts only. Paths, credentials, user messages, project
 * content and complete Prompt bodies are deliberately absent from this wire shape.
 */
export interface XiaoguiPromptContextV1 {
  readonly schemaVersion: typeof XIAOGUI_PROMPT_CONTRACT_SCHEMA_VERSION_V1
  readonly mode: XiaoguiMode
  readonly phase: XiaoguiExecutionPhase
  readonly workspaceAvailable: boolean
  readonly projectTrusted: boolean
  readonly enabledCapabilities: readonly XiaoguiCapabilityId[]
  readonly availableToolNames: readonly string[]
  /** Opaque identifier only; never a Session file path. */
  readonly sessionKey?: string
  /** Opaque identifier only; never a project root path. */
  readonly projectId?: string
}

/**
 * In-process product Layer definition. `content` must be code-owned and static;
 * never serialize this shape across IPC or place it in ordinary logs.
 */
export interface XiaoguiPromptLayerV1 {
  readonly id: string
  readonly version: string
  readonly kind: XiaoguiPromptLayerKindV1
  readonly required: boolean
  readonly content: string
}

export interface EffectivePromptLayerManifestV1 {
  readonly id: string
  readonly version: string
  readonly kind: XiaoguiPromptLayerKindV1
  readonly required: boolean
  readonly characterCount: number
  readonly sha256: string
}

/** Safe diagnostic shape: hashes and identifiers only, never Prompt or project text. */
export interface EffectivePromptManifestV1 {
  readonly schemaVersion: typeof XIAOGUI_PROMPT_CONTRACT_SCHEMA_VERSION_V1
  readonly mode: XiaoguiMode
  readonly phase: XiaoguiExecutionPhase
  readonly workspaceAvailable: boolean
  readonly projectTrusted: boolean
  readonly capabilityIds: readonly XiaoguiCapabilityId[]
  readonly toolNames: readonly string[]
  readonly layers: readonly EffectivePromptLayerManifestV1[]
  readonly completePromptCharacterCount: number
  readonly completePromptSha256: string
  /** Observation metadata only; excluded from content hashing by contract. */
  readonly generatedAt: string
}

export type XiaoguiPromptMigrationNoticeCodeV1 =
  | 'LEGACY_DESIGN_PROMPT_RUNTIME_DEDUPED'

/**
 * Safe Worker -> Main diagnostic view. It deliberately excludes Prompt bodies,
 * filesystem paths and project content; PR4 may expose this shape without
 * creating a second Prompt assembly path.
 */
export interface XiaoguiEffectivePromptDiagnosticsV1 {
  readonly manifest: EffectivePromptManifestV1
  readonly migrationNotices: readonly {
    readonly code: XiaoguiPromptMigrationNoticeCodeV1
    readonly fileMutation: false
  }[]
}

/**
 * Explicit advanced-diagnostic response. `prompt` contains code-owned product
 * Layers only. Pi System, user SYSTEM/Append and project context must never
 * cross the Worker seam; their contribution remains observable only through
 * the complete character count and SHA-256 in the Manifest.
 */
export interface XiaoguiAdvancedPromptDiagnosticsV1
  extends XiaoguiEffectivePromptDiagnosticsV1 {
  readonly prompt: string
}

const CONTEXT_KEYS = new Set([
  'schemaVersion',
  'mode',
  'phase',
  'workspaceAvailable',
  'projectTrusted',
  'enabledCapabilities',
  'availableToolNames',
  'sessionKey',
  'projectId',
])

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,159}$/
const LAYER_ID = /^[a-z0-9][a-z0-9._-]{0,159}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ABSOLUTE_PATH = /(?:^|[\s("'`])(?:[A-Za-z]:[\\/]|\\\\|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)/m
const SECRET_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|token|secret|password)\b\s*[:=]\s*\S+/i
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const DYNAMIC_BODY = /\$\{|\{\{|<project_context>/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(code: string): never {
  throw new Error(code)
}

function hasUniqueStrings(value: readonly string[]): boolean {
  return new Set(value).size === value.length
}

/**
 * Strict parser for the future Main → Worker Prompt Context seam. It is exported in
 * PR1 for contract tests only; production Session wiring belongs to PR2.
 */
export function parseXiaoguiPromptContextV1(value: unknown): XiaoguiPromptContextV1 {
  if (!isRecord(value)) fail('XIAOGUI_PROMPT_CONTEXT_INVALID')
  for (const key of Object.keys(value)) {
    if (!CONTEXT_KEYS.has(key)) fail('XIAOGUI_PROMPT_CONTEXT_UNKNOWN_FIELD')
  }
  if (value.schemaVersion !== XIAOGUI_PROMPT_CONTRACT_SCHEMA_VERSION_V1) {
    fail('XIAOGUI_PROMPT_CONTEXT_SCHEMA_UNSUPPORTED')
  }
  if (!XIAOGUI_PROMPT_MODES_V1.includes(value.mode as XiaoguiMode)) {
    fail('XIAOGUI_PROMPT_CONTEXT_MODE_INVALID')
  }
  if (!XIAOGUI_PROMPT_PHASES_V1.includes(value.phase as XiaoguiExecutionPhase)) {
    fail('XIAOGUI_PROMPT_CONTEXT_PHASE_INVALID')
  }
  if (typeof value.workspaceAvailable !== 'boolean' || typeof value.projectTrusted !== 'boolean') {
    fail('XIAOGUI_PROMPT_CONTEXT_FACT_INVALID')
  }
  if (!Array.isArray(value.enabledCapabilities)) {
    fail('XIAOGUI_PROMPT_CONTEXT_CAPABILITIES_INVALID')
  }
  const enabledCapabilities = value.enabledCapabilities as unknown[]
  if (
    !enabledCapabilities.every((item) =>
      XIAOGUI_CAPABILITY_IDS_V1.includes(item as XiaoguiCapabilityId),
    ) ||
    !hasUniqueStrings(enabledCapabilities as string[])
  ) {
    fail('XIAOGUI_PROMPT_CONTEXT_CAPABILITIES_INVALID')
  }
  if (
    !Array.isArray(value.availableToolNames) ||
    !value.availableToolNames.every((item) => typeof item === 'string' && TOOL_NAME.test(item)) ||
    !hasUniqueStrings(value.availableToolNames as string[])
  ) {
    fail('XIAOGUI_PROMPT_CONTEXT_TOOLS_INVALID')
  }
  for (const key of ['sessionKey', 'projectId'] as const) {
    const identifier = value[key]
    if (identifier !== undefined && (typeof identifier !== 'string' || !OPAQUE_ID.test(identifier))) {
      fail('XIAOGUI_PROMPT_CONTEXT_IDENTIFIER_INVALID')
    }
  }

  return {
    schemaVersion: XIAOGUI_PROMPT_CONTRACT_SCHEMA_VERSION_V1,
    mode: value.mode as XiaoguiMode,
    phase: value.phase as XiaoguiExecutionPhase,
    workspaceAvailable: value.workspaceAvailable,
    projectTrusted: value.projectTrusted,
    enabledCapabilities: [...(enabledCapabilities as XiaoguiCapabilityId[])],
    availableToolNames: [...(value.availableToolNames as string[])],
    ...(value.sessionKey === undefined ? {} : { sessionKey: value.sessionKey as string }),
    ...(value.projectId === undefined ? {} : { projectId: value.projectId as string }),
  }
}

/** Enforces the static product-Layer content rule before PR2 introduces a Builder. */
export function assertStaticXiaoguiPromptLayerV1(
  layer: XiaoguiPromptLayerV1,
): XiaoguiPromptLayerV1 {
  if (!LAYER_ID.test(layer.id) || !SEMVER.test(layer.version)) {
    fail('XIAOGUI_PROMPT_LAYER_IDENTITY_INVALID')
  }
  if (!XIAOGUI_PROMPT_LAYER_KINDS_V1.includes(layer.kind)) {
    fail('XIAOGUI_PROMPT_LAYER_KIND_INVALID')
  }
  if (!layer.content.trim()) fail('XIAOGUI_PROMPT_LAYER_CONTENT_EMPTY')
  if (ABSOLUTE_PATH.test(layer.content)) fail('XIAOGUI_PROMPT_LAYER_ABSOLUTE_PATH_FORBIDDEN')
  if (SECRET_ASSIGNMENT.test(layer.content) || PRIVATE_KEY.test(layer.content)) {
    fail('XIAOGUI_PROMPT_LAYER_SECRET_FORBIDDEN')
  }
  if (DYNAMIC_BODY.test(layer.content)) fail('XIAOGUI_PROMPT_LAYER_DYNAMIC_BODY_FORBIDDEN')
  return layer
}
