import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'

import type {
  RuntimeCapabilityV2,
  RuntimeCreateOrResumeOutcomeV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeOutcomeV1,
  RuntimeWorkspaceBindingV1,
} from '@shared/xiaogui-agent-runtime'

import { ScriptedAgentRuntimeAdapterV1 } from '../agent-runtime/scripted-adapter'
import type { AttemptRuntimeWorkspaceAccessV1 } from './attempt-workspace'

interface PiE2eAttemptWorkspaceAccessPortV1 {
  runtimeAccess(attemptId: string): Promise<AttemptRuntimeWorkspaceAccessV1 | undefined>
}

interface PiE2eScenarioTaskV1 {
  readonly label: string
  readonly role?: 'RESEARCH' | 'IMPLEMENT' | 'REVIEW'
  readonly allowedPath: string
  readonly releaseFile: string
  readonly barrier?: string
  readonly content: string
  readonly requires?: readonly { readonly relativePath: string; readonly content: string }[]
  readonly forbids?: readonly string[]
}

interface PiE2eScenarioV1 {
  readonly version: 1
  readonly eventLog: string
  readonly tasks: readonly PiE2eScenarioTaskV1[]
}

interface PiE2eRuntimeSessionV1 {
  readonly runtimeSessionId: string
  readonly task: PiE2eScenarioTaskV1
  readonly access: AttemptRuntimeWorkspaceAccessV1
  entered: boolean
  outcome?: RuntimeOutcomeV1
}

const SCRIPTED_ADAPTER_ID = 'pi-e2e-scripted-local'
const SCRIPTED_RUNTIME_TOKEN_ARG = '--pi-e2e-scripted-runtime-token='
const SCRIPTED_RUNTIME_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const SCRIPTED_RUNTIME_CONTROLLED_ROOTS = [
  'D:\\CodexTemp\\xiaogui-hub-m4g-real-journey-v1\\evidence',
  'D:\\CodexTemp\\xiaogui-hub-m4g-real-journey-v1\\runs',
].map((root) => resolve(root))
const authorizedScriptedRuntimeLaunches = new WeakSet<object>()
let activeScriptedRuntimeLaunch: PiE2eScriptedRuntimeLaunchV1 | undefined

export interface PiE2eScriptedRuntimeGateInputV1 {
  readonly isPackaged: boolean
  readonly argv: readonly string[]
  readonly env: Readonly<NodeJS.ProcessEnv>
}

export interface PiE2eScriptedRuntimeLaunchV1 {
  readonly scenarioPath: string
  readonly eventLogPath: string
}

export function resolvePiE2eScriptedRuntimeLaunchV1(
  input: PiE2eScriptedRuntimeGateInputV1,
): PiE2eScriptedRuntimeLaunchV1 | undefined {
  if (input.isPackaged || input.env.PI_E2E !== '1') return undefined
  const environmentToken = input.env.PI_E2E_SCRIPTED_RUNTIME_TOKEN
  const argumentTokens = input.argv
    .filter((value) => value.startsWith(SCRIPTED_RUNTIME_TOKEN_ARG))
    .map((value) => value.slice(SCRIPTED_RUNTIME_TOKEN_ARG.length))
  if (
    !environmentToken ||
    !SCRIPTED_RUNTIME_TOKEN_PATTERN.test(environmentToken) ||
    argumentTokens.length !== 1 ||
    argumentTokens[0] !== environmentToken
  ) return undefined
  const scenarioPath = input.env.PI_E2E_SCRIPTED_RUNTIME_SCENARIO
  const eventLogPath = input.env.PI_E2E_EVENT_LOG
  if (!scenarioPath || !eventLogPath || !isAbsolute(scenarioPath) || !isAbsolute(eventLogPath)) return undefined
  try {
    const resolvedScenarioPath = resolveControlledExistingFile(scenarioPath)
    const resolvedEventLogPath = resolveControlledOutputPath(eventLogPath)
    if (!resolvedScenarioPath || !resolvedEventLogPath) return undefined
    const scenario = parseScenario(readFileSync(resolvedScenarioPath, 'utf8'))
    const scenarioEventLogPath = resolveControlledOutputPath(
      resolveScenarioPath(dirname(resolvedScenarioPath), scenario.eventLog),
    )
    if (scenarioEventLogPath !== resolvedEventLogPath) return undefined
    const launch = Object.freeze({ scenarioPath: resolvedScenarioPath, eventLogPath: resolvedEventLogPath })
    authorizedScriptedRuntimeLaunches.add(launch)
    return launch
  } catch {
    return undefined
  }
}

function resolveControlledExistingFile(value: string): string | undefined {
  const target = resolve(value)
  const root = controlledRootFor(target)
  if (!root || !existsSync(target) || !hasLinkFreeExistingPath(root, target)) {
    return undefined
  }
  const targetStats = lstatSync(target)
  if (!targetStats.isFile() || targetStats.isSymbolicLink() || targetStats.nlink !== 1) return undefined
  const resolvedRoot = realpathSync(root)
  const resolvedTarget = realpathSync(target)
  return pathKey(resolvedRoot) === pathKey(root) && isInside(resolvedRoot, resolvedTarget) ? target : undefined
}

function resolveControlledOutputPath(value: string): string | undefined {
  const target = resolve(value)
  const root = controlledRootFor(target)
  const parent = dirname(target)
  if (
    !root ||
    !existsSync(parent) ||
    !hasLinkFreeExistingPath(root, parent) ||
    (existsSync(target) && (lstatSync(target).isSymbolicLink() || lstatSync(target).nlink !== 1))
  ) return undefined
  const resolvedRoot = realpathSync(root)
  const resolvedParent = realpathSync(parent)
  return (
    pathKey(resolvedRoot) === pathKey(root) &&
    (pathKey(resolvedParent) === pathKey(resolvedRoot) || isInside(resolvedRoot, resolvedParent))
  ) ? target : undefined
}

function controlledRootFor(target: string): string | undefined {
  return SCRIPTED_RUNTIME_CONTROLLED_ROOTS.find((root) => isInside(root, target))
}

function hasLinkFreeExistingPath(root: string, target: string): boolean {
  if (!existsSync(root)) return false
  const pathParts = relative(root, target).split(sep).filter(Boolean)
  let current = root
  if (lstatSync(current).isSymbolicLink()) return false
  for (const pathPart of pathParts) {
    current = resolve(current, pathPart)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return false
  }
  return true
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

const SCRIPTED_CAPABILITY = {
  adapterId: SCRIPTED_ADAPTER_ID,
  runtimeKind: 'OTHER',
  protocol: 'HEADLESS',
  capabilityDigest: digest('pi-e2e-scripted-runtime-v1'),
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
  health: 'AVAILABLE',
  canCreateSession: true,
  canResumeSession: true,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'RECONCILE',
  interactivePermission: 'HOST_MEDIATED',
  diagnosticOnly: false,
  version: 2,
  runtimeVersion: 'e2e-script-v1',
  capabilitySummary: '受控 E2E Scripted Runtime',
  workModes: ['CODING'],
  taskCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'],
  executionLocation: 'LOCAL',
  requiresDataEgress: false,
  supportsResume: true,
  supportsEventStream: true,
  supportsInterrupt: true,
  supportsResultReconcile: true,
} satisfies RuntimeCapabilityV2

export const PI_E2E_SCRIPTED_RUNTIME_ROUTING_POLICY_V1 = {
  mode: 'CODING',
  requiredCapabilities: ['CODING.GIT.CHANGESET', 'CODING.TYPESCRIPT', 'EXECUTION.LOCAL_ONLY'],
  dataEgressPolicy: 'LOCAL_ONLY',
  priorityAdapterIds: [SCRIPTED_ADAPTER_ID],
  requireProductionApproval: true,
} as const

/**
 * Explicit Electron-E2E-only adapter. It uses the real Attempt worktree access
 * port and writes only a scenario task's already-authorized relative file.
 */
export class PiE2eWorkspaceScriptedRuntimeAdapterV1 extends ScriptedAgentRuntimeAdapterV1 {
  private readonly scenarioRoot: string
  private readonly scenario: PiE2eScenarioV1
  private readonly eventLogPath: string
  private readonly sessions = new Map<string, PiE2eRuntimeSessionV1>()
  private readonly enteredLabels = new Set<string>()

  constructor(
    private readonly attempts: PiE2eAttemptWorkspaceAccessPortV1,
    launch: PiE2eScriptedRuntimeLaunchV1,
  ) {
    if (!authorizedScriptedRuntimeLaunches.has(launch)) {
      throw new Error('PI_E2E_SCRIPTED_RUNTIME_FORBIDDEN')
    }
    super({ capabilities: [SCRIPTED_CAPABILITY] })
    const scenarioPath = launch.scenarioPath
    if (!isAbsolute(scenarioPath)) throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
    const resolvedScenarioPath = resolveControlledExistingFile(scenarioPath)
    if (!resolvedScenarioPath) throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
    this.scenarioRoot = dirname(resolvedScenarioPath)
    this.scenario = parseScenario(readFileSync(resolvedScenarioPath, 'utf8'))
    const resolvedEventLogPath = resolveControlledOutputPath(
      resolveScenarioPath(this.scenarioRoot, this.scenario.eventLog),
    )
    if (!resolvedEventLogPath || resolvedEventLogPath !== launch.eventLogPath) {
      throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
    }
    this.eventLogPath = resolvedEventLogPath
    activeScriptedRuntimeLaunch = launch
    mkdirSync(dirname(this.eventLogPath), { recursive: true })
    this.record('runtime.adapter.ready', { taskCount: this.scenario.tasks.length })
  }

  override async createOrResume(request: RuntimeCreateOrResumeRequestV1): Promise<RuntimeCreateOrResumeOutcomeV1> {
    this.record('runtime.dispatch.received', {})
    const access = await this.attempts.runtimeAccess(request.scope.attemptId)
    if (!access) {
      this.record('runtime.dispatch.rejected', { reasonCode: 'PI_E2E_WORKSPACE_ACCESS_MISSING' })
      return failedOutcome('runtime-unbound', 'PI_E2E_WORKSPACE_ACCESS_MISSING')
    }
    if (!sameWorkspaceBinding(request.workspace, access.workspace)) {
      this.record('runtime.dispatch.rejected', { reasonCode: 'PI_E2E_WORKSPACE_BINDING_REJECTED' })
      return failedOutcome('runtime-unbound', 'PI_E2E_WORKSPACE_BINDING_REJECTED')
    }
    const task = this.scenario.tasks.find((candidate) =>
      access.allowedFiles.some((allowed) => allowed.relativePath === candidate.allowedPath),
    )
    if (!task || access.allowedFiles.length !== 1 || access.allowedFiles[0]?.relativePath !== task.allowedPath) {
      this.record('runtime.dispatch.rejected', { reasonCode: 'PI_E2E_SCENARIO_TASK_NOT_FOUND' })
      return failedOutcome('runtime-unbound', 'PI_E2E_SCENARIO_TASK_NOT_FOUND')
    }
    const expectedRole = task.role ?? 'IMPLEMENT'
    if (
      !request.codingRole ||
      request.codingRole.role !== expectedRole ||
      (expectedRole === 'IMPLEMENT'
        ? request.codingRole.effectiveToolAllowlist.length === 0
        : JSON.stringify(request.codingRole.effectiveToolAllowlist) !== JSON.stringify(['read']))
    ) {
      this.record('runtime.dispatch.rejected', { reasonCode: 'PI_E2E_ROLE_BINDING_REJECTED' })
      return failedOutcome('runtime-unbound', 'PI_E2E_ROLE_BINDING_REJECTED')
    }
    const runtimeSessionId = `pi-e2e-runtime-${hashHex(request.scope.attemptId).slice(0, 24)}`
    if (!this.sessions.has(runtimeSessionId)) {
      this.sessions.set(runtimeSessionId, { runtimeSessionId, task, access, entered: false })
      this.record('runtime.session.ready', {
        label: task.label,
        allowedRelativePaths: access.allowedFiles.map((file) => file.relativePath),
        worktreeIdentityDigest: request.workspace.worktreeRootDigest,
      })
    }
    return { state: 'READY', runtimeSessionId }
  }

  override async inspect(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    const session = this.sessions.get(runtimeSessionId)
    if (!session) return unknownOutcome(runtimeSessionId, 'PI_E2E_SESSION_NOT_FOUND')
    if (session.outcome) return session.outcome
    if (!session.entered) {
      session.entered = true
      this.enteredLabels.add(session.task.label)
      this.record('runtime.execution.entered', {
        label: session.task.label,
        barrier: session.task.barrier ?? null,
      })
    }
    if (!this.barrierReached(session.task) || !existsSync(resolveScenarioPath(this.scenarioRoot, session.task.releaseFile))) {
      return unknownOutcome(runtimeSessionId, 'RUNTIME_STILL_RUNNING')
    }

    try {
      const dependencyChecks = (session.task.requires ?? []).map((required) => {
        const actual = normalizeRequiredText(readFileSync(
          resolveWorktreePath(session.access.rootPath, required.relativePath),
          'utf8',
        ))
        if (actual !== normalizeRequiredText(required.content)) throw new Error('PI_E2E_REQUIRED_CONTENT_MISMATCH')
        return { relativePath: required.relativePath, contentDigest: digest(actual) }
      })
      const forbiddenChecks = (session.task.forbids ?? []).map((forbidden) => {
        const absent = !existsSync(resolveWorktreePath(session.access.rootPath, forbidden))
        if (!absent) throw new Error('PI_E2E_FORBIDDEN_DEPENDENCY_PRESENT')
        return { relativePath: forbidden, absent }
      })
      if (dependencyChecks.length > 0 || forbiddenChecks.length > 0) {
        this.record('runtime.dependency.baseline.checked', {
          label: session.task.label,
          required: dependencyChecks,
          forbidden: forbiddenChecks,
        })
      }

      const role = session.task.role ?? 'IMPLEMENT'
      if (role === 'IMPLEMENT') {
        writeFileSync(resolveWorktreePath(session.access.rootPath, session.task.allowedPath), session.task.content, 'utf8')
      }
      const receiptDigest = digest(`receipt:${session.task.label}:${session.task.content}`)
      session.outcome = {
        state: 'SUCCEEDED',
        runtimeSessionId,
        receiptDigest,
        candidateDigest: digest(`candidate:${session.task.label}:${session.task.content}`),
      }
      this.record('runtime.execution.succeeded', {
        label: session.task.label,
        role,
        changedRelativePaths: role === 'IMPLEMENT' ? [session.task.allowedPath] : [],
        receiptDigest,
      })
      return session.outcome
    } catch (error) {
      const reasonCode = error instanceof Error && /^PI_E2E_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'PI_E2E_SCRIPT_EXECUTION_FAILED'
      session.outcome = failedOutcome(runtimeSessionId, reasonCode)
      this.record('runtime.execution.failed', { label: session.task.label, reasonCode })
      return session.outcome
    }
  }

  override reconcile(runtimeSessionId: string): Promise<RuntimeOutcomeV1> {
    return this.inspect(runtimeSessionId)
  }

  private barrierReached(task: PiE2eScenarioTaskV1): boolean {
    if (!task.barrier) return true
    return this.scenario.tasks
      .filter((candidate) => candidate.barrier === task.barrier)
      .every((candidate) => this.enteredLabels.has(candidate.label))
  }

  private record(event: string, details: Record<string, unknown>): void {
    appendPiE2eEvent(this.eventLogPath, event, details)
  }
}

/** Record a deliberately sanitized renderer-to-main IPC fact for the E2E trace. */
export function recordPiE2eRendererEventV1(event: string, details: Record<string, unknown>): void {
  if (!activeScriptedRuntimeLaunch) return
  appendPiE2eEvent(activeScriptedRuntimeLaunch.eventLogPath, event, details)
}

export function deactivatePiE2eScriptedRuntimeLaunchV1(launch: PiE2eScriptedRuntimeLaunchV1): void {
  if (activeScriptedRuntimeLaunch === launch) activeScriptedRuntimeLaunch = undefined
}

function appendPiE2eEvent(eventLogPath: string, event: string, details: Record<string, unknown>): void {
  const publicRecord = { event, details }
  if (containsAbsolutePath(publicRecord) || JSON.stringify(publicRecord).includes('runtimeSessionId')) {
    throw new Error('PI_E2E_PUBLIC_EVENT_LEAK')
  }
  const controlledEventLogPath = resolveControlledOutputPath(eventLogPath)
  if (!controlledEventLogPath) throw new Error('PI_E2E_EVENT_LOG_FORBIDDEN')
  mkdirSync(dirname(controlledEventLogPath), { recursive: true })
  appendFileSync(controlledEventLogPath, `${JSON.stringify(publicRecord)}\n`, 'utf8')
}

function parseScenario(source: string): PiE2eScenarioV1 {
  const value = JSON.parse(source) as Partial<PiE2eScenarioV1>
  if (value.version !== 1 || typeof value.eventLog !== 'string' || !Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
  }
  const labels = new Set<string>()
  const allowedPaths = new Set<string>()
  for (const task of value.tasks) {
    if (
      !task ||
      !isSafeLabel(task.label) ||
      labels.has(task.label) ||
      !isSafeRelativePath(task.allowedPath) ||
      allowedPaths.has(task.allowedPath) ||
      !isSafeRelativePath(task.releaseFile) ||
      typeof task.content !== 'string' ||
      task.content.length === 0 ||
      (task.role !== undefined && task.role !== 'RESEARCH' && task.role !== 'IMPLEMENT' && task.role !== 'REVIEW') ||
      (task.barrier !== undefined && !isSafeLabel(task.barrier)) ||
      !(task.requires ?? []).every((item: { relativePath: unknown; content: unknown }) =>
        isSafeRelativePath(item.relativePath) && typeof item.content === 'string') ||
      !(task.forbids ?? []).every(isSafeRelativePath)
    ) {
      throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
    }
    labels.add(task.label)
    allowedPaths.add(task.allowedPath)
  }
  if (!isSafeRelativePath(value.eventLog)) throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
  return value as PiE2eScenarioV1
}

function resolveScenarioPath(root: string, value: string): string {
  if (!isSafeRelativePath(value)) throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
  const target = resolve(root, ...value.split('/'))
  if (!isInside(root, target)) throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
  return target
}

function resolveWorktreePath(root: string, value: string): string {
  if (!isSafeRelativePath(value)) throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
  const target = resolve(root, ...value.split('/'))
  if (!isInside(root, target)) throw new Error('PI_E2E_SCRIPTED_SCENARIO_INVALID')
  return target
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false
  const normalized = posix.normalize(value)
  return normalized === value && normalized !== '.' && !normalized.startsWith('../') && !posix.isAbsolute(normalized)
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value)
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function sameWorkspaceBinding(actual: RuntimeWorkspaceBindingV1, expected: RuntimeWorkspaceBindingV1): boolean {
  const keys = [
    'attemptWorktreeId',
    'worktreeRootDigest',
    'baseRevisionDigest',
    'targetProjectRootDigest',
    'writePolicy',
  ] as const
  return Object.keys(actual).length === keys.length && keys.every((key) => actual[key] === expected[key])
}

function unknownOutcome(runtimeSessionId: string, reasonCode: string): RuntimeOutcomeV1 {
  return {
    state: 'OUTCOME_UNKNOWN',
    runtimeSessionId,
    inspectHandleDigest: digest(`inspect:${runtimeSessionId}:${reasonCode}`),
    reasonCode,
  }
}

function failedOutcome(runtimeSessionId: string, reasonCode: string): Extract<RuntimeOutcomeV1, { state: 'FAILED' }> {
  return { state: 'FAILED', runtimeSessionId, receiptDigest: digest(`failed:${runtimeSessionId}:${reasonCode}`), reasonCode }
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function hashHex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeRequiredText(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return isAbsolute(value) || win32.isAbsolute(value)
  if (Array.isArray(value)) return value.some(containsAbsolutePath)
  if (value && typeof value === 'object') return Object.values(value).some(containsAbsolutePath)
  return false
}
