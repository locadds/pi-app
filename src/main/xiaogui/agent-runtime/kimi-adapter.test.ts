import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  RuntimeAdapterSelectionV1,
  RuntimeContractTestCreateOrResumeRequestV1,
  RuntimeContractTestPolicyV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimeMessageEnvelopeRefV1,
  RuntimeProductionPolicyV1,
  RuntimeTestAdapterSelectionV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

import { createAgentRuntimeContractTestHostV1, createAgentRuntimeHostV1 } from './runtime-host'
import type {
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpSessionUpdateParamsV1,
  AcpTransportCreateOptionsV1,
  AcpTransportFactoryV1,
  AcpTransportStartOptionsV1,
  AcpTransportV1,
} from './acp/types'
import { NdjsonAcpProcessTransportV1 } from './acp/process-transport'
import { KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1 } from './acp/kimi-tool-policy'
import { digestBytes } from './acp/workspace-policy'
import {
  createKimiAcpRuntimeAdapterV1,
  KimiAcpCliProbeV1,
  KimiAcpRuntimeAdapterV1,
  kimiAcpCapabilityDigestForVersionV1,
  type KimiAcpWorkspaceResolverV1,
} from './kimi-adapter'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
  }
})

const testSelection = {
  adapterId: 'kimi-acp',
  runtimeKind: 'KIMI',
  protocol: 'ACP',
  capabilityDigest: kimiAcpCapabilityDigestForVersionV1('0.34.0'),
  approvalStatus: 'APPROVED_FOR_TEST',
  diagnosticOnly: false,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'RECONCILE',
} satisfies RuntimeTestAdapterSelectionV1

const productionSelection = {
  ...testSelection,
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
} satisfies RuntimeAdapterSelectionV1

const productionPolicy = {
  rejectDiagnosticOnly: true,
  allowedSelections: [productionSelection],
} satisfies RuntimeProductionPolicyV1

const contractTestPolicy = {
  rejectDiagnosticOnly: true,
  workspacePolicy: 'ATTEMPT_WORKTREE_ONLY',
  productEnablement: false,
  allowedSelections: [testSelection],
} satisfies RuntimeContractTestPolicyV1

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-kimi-acp-'))
  roots.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(root, relativePath), content)
  }
  return root
}

function isolatedKimiCodeHome() {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-kimi-home-'))
  roots.push(root)
  writeFileSync(join(root, 'config.toml'), '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n')
  mkdirSync(join(root, 'agents'))
  writeFileSync(join(root, 'agents', 'agent.md'), KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1)
  return root
}

function configuredKimiCodeHome(config: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-kimi-home-'))
  roots.push(root)
  if (config !== null) writeFileSync(join(root, 'config.toml'), `[tools]\n${config}`)
  mkdirSync(join(root, 'agents'))
  writeFileSync(join(root, 'agents', 'agent.md'), KIMI_ACP_LEGACY_AGENT_PROFILE_CONTENT_V1)
  return root
}

function request(rootPath: string, prompt = 'edit safely', overrides: Partial<RuntimeContractTestCreateOrResumeRequestV1> = {}): RuntimeContractTestCreateOrResumeRequestV1 {
  const promptBytes = Buffer.from(prompt, 'utf8')
  return {
    executionMode: 'CONTRACT_TEST',
    requestId: 'req-1',
    scope: {
      projectId: 'xgp_project',
      sessionKey: 'xgs_session',
      sessionMode: 'CODING',
      flowId: 'flow-1',
      taskRunId: 'run-1',
      attemptId: 'attempt-1',
      attemptDigest: 'sha256:attempt',
      workspaceReceiptId: 'workspace-receipt-1',
      workspaceReceiptDigest: 'sha256:workspace',
    },
    workspace: {
      attemptWorktreeId: 'worktree-1',
      worktreeRootDigest: digestBytes(Buffer.from(rootPath)),
      baseRevisionDigest: 'sha256:base',
      targetProjectRootDigest: 'sha256:target',
      writePolicy: 'ATTEMPT_WORKTREE_ONLY',
    },
    selection: testSelection,
    contractTestPolicy: { ...contractTestPolicy, allowedSelections: [...contractTestPolicy.allowedSelections] },
    promptEnvelopeRef: {
      refId: 'prompt-1',
      digest: digestBytes(promptBytes),
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
    ...overrides,
  }
}

function productionRequest(
  rootPath: string,
  overrides: Partial<RuntimeCreateOrResumeRequestV1> = {},
): RuntimeCreateOrResumeRequestV1 {
  const base = request(rootPath)
  const { executionMode: _executionMode, contractTestPolicy: _contractTestPolicy, selection: _selection, ...productionBase } = base
  return {
    ...productionBase,
    selection: productionSelection,
    productionPolicy,
    ...overrides,
  }
}

function codingRole(role: 'RESEARCH' | 'IMPLEMENT' | 'REVIEW') {
  return {
    schemaVersion: 1 as const,
    profileId: `xiaogui.role.${role.toLowerCase()}.default`,
    role,
    modelSelector: 'inherit',
    runtimePolicyId: 'xiaogui.runtime.default',
    effectiveToolAllowlist: role === 'IMPLEMENT' ? ['read', 'bash', 'edit', 'write'] : ['read'],
    profileDigest: `sha256:${role.toLowerCase()}-profile`,
    snapshotDigest: `sha256:${role.toLowerCase()}-snapshot`,
  }
}

function messageRef(text = 'guidance text'): RuntimeMessageEnvelopeRefV1 {
  const bytes = Buffer.from(text, 'utf8')
  return {
    refId: 'message-1',
    digest: digestBytes(bytes),
    mediaType: 'application/vnd.xiaogui.runtime-message+json',
  }
}

function resolver(rootPath: string, allowed = ['a.txt'], resumeSessionId?: string, kimiCodeHome = isolatedKimiCodeHome()): KimiAcpWorkspaceResolverV1 {
  return {
    async resolve() {
      return {
        rootPath,
        kimiCodeHome,
        allowedFiles: allowed.map((relativePath) => ({
          relativePath,
          contentDigest: digestBytes(Buffer.from(readFileSync(join(rootPath, relativePath)))),
        })),
        resumeSessionId,
      }
    },
  }
}

function payloadResolver(text = 'edit safely'): TrustedRuntimePayloadResolverV1 {
  const bytes = Buffer.from(text, 'utf8')
  return {
    async resolvePrompt(ref) {
      return {
        promptEnvelopeRef: ref,
        redactedPreviewDigest: 'sha256:redacted',
        payloadBytes: bytes,
      }
    },
    async resolveMessage(ref) {
      return {
        messageEnvelopeRef: ref,
        redactedPreviewDigest: 'sha256:redacted-message',
        payloadBytes: Buffer.from('guidance text', 'utf8'),
      }
    },
    async *resolveTextStream() {},
    async resolveCandidateFile(ref) {
      return {
        candidateFileRef: ref,
        relativePathDigest: 'sha256:path',
        contentDigest: 'sha256:content',
        payloadBytes: new Uint8Array(),
      }
    },
    async toM2ChangeSetCandidate(input) {
      return { changeSetCandidateId: 'not-created-by-adapter', digest: input.candidateDigest }
    },
  }
}

class FakeProbe {
  constructor(private readonly available = true, private readonly version: string | null = '0.34.0') {}

  async findExecutable() {
    if (!this.available) return { available: false as const, reasonCode: 'EXECUTABLE_NOT_FOUND' }
    return this.version === null ? { available: true as const, command: 'kimi' } : { available: true as const, command: 'kimi', version: this.version }
  }
}

class FakeAcpTransport implements AcpTransportV1 {
  startOptions?: AcpTransportStartOptionsV1
  newSessionCalls = 0
  loadSessionCalls: Array<{ sessionId: string; cwd: string }> = []
  promptCalls = 0
  activePromptCalls = 0
  maxConcurrentPromptCalls = 0
  prompts: Array<Array<{ type: string; text?: string }>> = []
  cancelCalls = 0
  disposeCalls = 0
  permissionPromise?: Promise<AcpRequestPermissionResultV1>

  constructor(
    private readonly script?: (transport: FakeAcpTransport, sessionId: string) => Promise<void> | void,
    private readonly createOptions?: AcpTransportCreateOptionsV1,
  ) {}

  async start(options: AcpTransportStartOptionsV1) {
    this.createOptions?.preSpawn?.()
    this.startOptions = options
    return { protocolVersion: 1, agentInfo: { name: 'Kimi', version: '0.34.0' }, agentCapabilities: { loadSession: true } }
  }

  async newSession() {
    this.newSessionCalls += 1
    return { sessionId: 'vendor-session-1' }
  }

  async loadSession(sessionId: string, cwd: string) {
    this.loadSessionCalls.push({ sessionId, cwd })
  }

  async prompt(sessionId: string, prompt: Array<{ type: string; text?: string }>) {
    this.promptCalls += 1
    this.activePromptCalls += 1
    this.maxConcurrentPromptCalls = Math.max(this.maxConcurrentPromptCalls, this.activePromptCalls)
    this.prompts.push(prompt)
    try {
      await this.script?.(this, sessionId)
      return { stopReason: 'end_turn' }
    } finally {
      this.activePromptCalls -= 1
    }
  }

  async cancel() {
    this.cancelCalls += 1
  }

  async dispose() {
    this.disposeCalls += 1
    this.disconnect('DISPOSED')
  }

  async reverse(method: string, params: unknown) {
    const handler = this.startOptions?.requestHandlers.get(method)
    if (!handler) throw new Error('missing handler')
    return handler(params)
  }

  requestPermission(params: AcpRequestPermissionParamsV1) {
    if (!this.startOptions) throw new Error('not started')
    this.permissionPromise = this.startOptions.onPermissionRequest(params)
    return this.permissionPromise
  }

  sessionUpdate(params: AcpSessionUpdateParamsV1) {
    if (!this.startOptions) throw new Error('not started')
    this.startOptions.onSessionUpdate(params)
  }

  disconnect(reasonCode = 'PROCESS_DISCONNECTED') {
    this.startOptions?.onDisconnect(reasonCode)
  }
}

class FakeTransportFactory implements AcpTransportFactoryV1 {
  readonly transports: FakeAcpTransport[] = []
  readonly createCalls: Array<{ command: string; args: readonly string[]; cwd: string; env?: Readonly<Record<string, string>> }> = []

  constructor(
    private readonly script?: (transport: FakeAcpTransport, sessionId: string) => Promise<void> | void,
    private readonly onCreate?: () => void,
  ) {}

  create(command: string, args: readonly string[], cwd: string, options?: AcpTransportCreateOptionsV1): AcpTransportV1 {
    this.createCalls.push({ command, args, cwd, env: options?.env })
    this.onCreate?.()
    const transport = new FakeAcpTransport(this.script, options)
    this.transports.push(transport)
    return transport
  }
}

async function collect(iterable: AsyncIterable<RuntimeEventV1>) {
  const events: RuntimeEventV1[] = []
  for await (const event of iterable) events.push(event)
  return events
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Kimi ACP runtime adapter M4B1 candidate', () => {
  it('probes KIMI_CLI_PATH before PATH and keeps executable path out of public capability data', async () => {
    const previous = process.env.KIMI_CLI_PATH
    process.env.KIMI_CLI_PATH = process.execPath
    try {
      const probe = await new KimiAcpCliProbeV1().findExecutable()
      expect(probe).toMatchObject({ available: true, command: process.execPath })
      if (probe.available) {
        expect(probe.version).toMatch(/\d+\.\d+/)
        const root = workspace({ 'a.txt': 'before' })
        const adapter = createKimiAcpRuntimeAdapterV1({
          payloadResolver: payloadResolver(),
          workspaceResolver: resolver(root),
          probe: { async findExecutable() { return probe } },
          transportFactory: new FakeTransportFactory(),
        })
        const [capability] = await adapter.discover()
        expect(JSON.stringify(capability)).not.toContain(process.execPath)
      }
    } finally {
      if (previous === undefined) delete process.env.KIMI_CLI_PATH
      else process.env.KIMI_CLI_PATH = previous
    }
  })

  it('defaults to APPROVED_FOR_TEST and rejects production before resolving a workspace', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory()
    let resolveCalls = 0
    const adapter = createKimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: {
        async resolve(input) {
          resolveCalls += 1
          return resolver(root).resolve(input)
        },
      },
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    await expect(adapter.discover()).resolves.toMatchObject([{ approvalStatus: 'APPROVED_FOR_TEST', health: 'AVAILABLE', stream: 'POLL' }])

    const host = createAgentRuntimeHostV1(adapter)
    await expect(host.createOrResume(productionRequest(root))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'KIMI_PRODUCTION_DISABLED',
    })
    await expect(
      Reflect.apply(host.createOrResume, host, [request(root)]),
    ).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'RUNTIME_CONTRACT_TEST_REQUEST_NOT_ALLOWED',
    })
    expect(resolveCalls).toBe(0)
    expect(factory.transports).toHaveLength(0)
  })

  it('runs an exact production selection only when the trusted production gate is enabled', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory()
    const adapter = createKimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
      productionGate: { enabled: true, selection: productionSelection },
    })

    await expect(adapter.discover()).resolves.toMatchObject([
      { approvalStatus: 'APPROVED_FOR_PRODUCTION', health: 'AVAILABLE', capabilityDigest: productionSelection.capabilityDigest },
    ])
    await expect(createAgentRuntimeHostV1(adapter).createOrResume(productionRequest(root))).resolves.toMatchObject({
      state: 'READY',
    })
    expect(factory.transports).toHaveLength(1)
  })

  it('rejects production selection drift before workspace resolution or transport creation', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory()
    let resolveCalls = 0
    const adapter = createKimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: {
        async resolve(input) {
          resolveCalls += 1
          return resolver(root).resolve(input)
        },
      },
      probe: new FakeProbe(),
      transportFactory: factory,
      productionGate: { enabled: true, selection: productionSelection },
    })
    const driftedSelection = { ...productionSelection, capabilityDigest: 'sha256:drift' }
    const driftedRequest: RuntimeCreateOrResumeRequestV1 = {
      ...productionRequest(root),
      selection: driftedSelection,
      productionPolicy: { rejectDiagnosticOnly: true, allowedSelections: [driftedSelection] },
    }

    await expect(adapter.createOrResume(driftedRequest)).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'KIMI_PRODUCTION_SELECTION_MISMATCH',
    })
    expect(resolveCalls).toBe(0)
    expect(factory.transports).toHaveLength(0)
  })

  it('fails closed for unknown or non-0.34.0 Kimi versions before transport creation', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const cases = [
      { name: 'unknown', version: null },
      { name: 'older', version: '0.33.9' },
      { name: 'newer', version: '0.34.1' },
    ]

    for (const item of cases) {
      const factory = new FakeTransportFactory()
      const adapter = new KimiAcpRuntimeAdapterV1({
        payloadResolver: payloadResolver(),
        workspaceResolver: resolver(root),
        probe: new FakeProbe(true, item.version),
        transportFactory: factory,
      })

      await expect(adapter.discover()).resolves.toMatchObject([{
        health: 'UNAVAILABLE',
        canCreateSession: false,
        reasonCode: 'KIMI_VERSION_UNAPPROVED',
      }])
      await expect(adapter.createOrResume(request(root, 'edit safely', { requestId: `req-version-${item.name}` }))).resolves.toMatchObject({
        state: 'FAILED',
        reasonCode: 'KIMI_VERSION_UNAPPROVED',
      })
      expect(factory.transports).toHaveLength(0)
    }
  })

  it('runs through the contract test Host and fails closed for invalid test policies', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory()
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const host = createAgentRuntimeContractTestHostV1(adapter)
    await expect(
      Reflect.apply(host.createOrResume, host, [productionRequest(root)]),
    ).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'RUNTIME_CONTRACT_TEST_REQUEST_REQUIRED',
    })

    const productEnabled = request(root)
    Object.defineProperty(productEnabled.contractTestPolicy, 'productEnablement', { value: true })
    const wrongWorkspacePolicy = request(root)
    Object.defineProperty(wrongWorkspacePolicy.contractTestPolicy, 'workspacePolicy', { value: 'TARGET_WORKTREE_ONLY' })

    await expect(host.createOrResume(productEnabled)).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'RUNTIME_CONTRACT_TEST_PRODUCT_ENABLEMENT_FORBIDDEN' })
    await expect(host.createOrResume(wrongWorkspacePolicy)).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'RUNTIME_CONTRACT_TEST_POLICY_INVALID' })
    await expect(host.createOrResume(request(root, 'edit safely', {
      selection: { ...testSelection, capabilityDigest: 'sha256:drift' },
    }))).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'RUNTIME_SELECTION_NOT_APPROVED_FOR_TEST' })
    expect(factory.transports).toHaveLength(0)
  })

  it('fails closed for hostile create inputs before adapter transport creation', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory()
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    await expect(Reflect.apply(adapter.createOrResume, adapter, [new Proxy(request(root), {
      get() {
        throw new Error('hostile get')
      },
      has() {
        throw new Error('hostile has')
      },
    })])).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'RUNTIME_CREATE_REQUEST_INVALID' })
    expect(factory.transports).toHaveLength(0)
  })

  it('fails closed before transport creation when fixed Kimi test selection fields drift', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const driftCases: Array<{
      name: string
      selection: RuntimeContractTestCreateOrResumeRequestV1['selection']
      expectedReasonCode?: string
    }> = [
      { name: 'runtimeKind', selection: { ...testSelection, runtimeKind: 'QODER' }, expectedReasonCode: 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST' },
      { name: 'diagnosticOnly', selection: { ...testSelection, diagnosticOnly: true as false } },
      { name: 'stream', selection: { ...testSelection, stream: 'PUSH' }, expectedReasonCode: 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST' },
      { name: 'interrupt', selection: { ...testSelection, interrupt: 'ACKED' }, expectedReasonCode: 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST' },
      { name: 'inspect', selection: { ...testSelection, inspect: 'SNAPSHOT' }, expectedReasonCode: 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST' },
    ]

    for (const driftCase of driftCases) {
      const factory = new FakeTransportFactory()
      const adapter = new KimiAcpRuntimeAdapterV1({
        payloadResolver: payloadResolver(),
        workspaceResolver: resolver(root),
        probe: new FakeProbe(),
        transportFactory: factory,
      })

      const outcome = await adapter.createOrResume(request(root, `edit safely ${driftCase.name}`, {
        requestId: `req-${driftCase.name}`,
        selection: driftCase.selection,
        contractTestPolicy: { ...contractTestPolicy, allowedSelections: [driftCase.selection] },
      }))
      expect(outcome).toMatchObject({ state: 'FAILED' })
      if (driftCase.expectedReasonCode) expect(outcome).toMatchObject({ reasonCode: driftCase.expectedReasonCode })
      expect(factory.transports).toHaveLength(0)
    }
  })

  it('fails closed before transport creation when the trusted KIMI_CODE_HOME policy is missing', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory()
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: {
        async resolve() {
          return {
            rootPath: root,
            allowedFiles: [{
              relativePath: 'a.txt',
              contentDigest: digestBytes(Buffer.from(readFileSync(join(root, 'a.txt')))),
            }],
          }
        },
      },
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    await expect(adapter.createOrResume(request(root))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'KIMI_TOOL_POLICY_HOME_MISSING',
    })
    expect(factory.transports).toHaveLength(0)
  })

  it('fails closed before transport creation when the trusted KIMI_CODE_HOME policy drifts', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const cases = [
      { name: 'relative', kimiCodeHome: 'relative-home', reasonCode: 'KIMI_TOOL_POLICY_HOME_NOT_ABSOLUTE' },
      { name: 'missing-config', kimiCodeHome: configuredKimiCodeHome(null), reasonCode: 'KIMI_TOOL_POLICY_CONFIG_MISSING' },
      { name: 'extra-bash', kimiCodeHome: configuredKimiCodeHome('enabled = ["Read", "Write", "Edit", "TodoList", "Bash"]\n'), reasonCode: 'KIMI_TOOL_POLICY_TOOL_FORBIDDEN' },
      { name: 'unknown-tool', kimiCodeHome: configuredKimiCodeHome('enabled = ["Read", "Write", "Edit", "TodoList", "FutureTool"]\n'), reasonCode: 'KIMI_TOOL_POLICY_TOOL_FORBIDDEN' },
      { name: 'incomplete', kimiCodeHome: configuredKimiCodeHome('enabled = ["Read", "Write", "Edit"]\n'), reasonCode: 'KIMI_TOOL_POLICY_ALLOWLIST_INCOMPLETE' },
      { name: 'order-drift', kimiCodeHome: configuredKimiCodeHome('enabled = ["TodoList", "Edit", "Write", "Read"]\n'), reasonCode: 'KIMI_TOOL_POLICY_ALLOWLIST_DRIFT' },
    ]

    for (const item of cases) {
      const factory = new FakeTransportFactory()
      const adapter = new KimiAcpRuntimeAdapterV1({
        payloadResolver: payloadResolver(),
        workspaceResolver: resolver(root, ['a.txt'], undefined, item.kimiCodeHome),
        probe: new FakeProbe(),
        transportFactory: factory,
      })

      await expect(adapter.createOrResume(request(root, `edit safely ${item.name}`, { requestId: `req-kimi-home-${item.name}` }))).resolves.toMatchObject({
        state: 'FAILED',
        reasonCode: item.reasonCode,
      })
      expect(factory.transports).toHaveLength(0)
    }
  })

  it('fails closed before ACP start when the trusted KIMI_CODE_HOME config changes after policy preparation', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const cases = [
      {
        name: 'content',
        reasonCode: 'KIMI_TOOL_POLICY_CONFIG_CONTENT_CHANGED',
        mutate(home: string) {
          writeFileSync(join(home, 'config.toml'), '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList", "Bash"]\n')
        },
      },
      {
        name: 'identity',
        reasonCode: 'KIMI_TOOL_POLICY_CONFIG_IDENTITY_CHANGED',
        mutate(home: string) {
          unlinkSync(join(home, 'config.toml'))
          writeFileSync(join(home, 'config.toml'), '[tools]\nenabled = ["Read", "Write", "Edit", "TodoList"]\n')
        },
      },
    ]

    for (const item of cases) {
      const kimiCodeHome = isolatedKimiCodeHome()
      const factory = new FakeTransportFactory(undefined, () => item.mutate(kimiCodeHome))
      const adapter = new KimiAcpRuntimeAdapterV1({
        payloadResolver: payloadResolver(`edit safely ${item.name}`),
        workspaceResolver: resolver(root, ['a.txt'], undefined, kimiCodeHome),
        probe: new FakeProbe(),
        transportFactory: factory,
      })

      await expect(adapter.createOrResume(request(root, `edit safely ${item.name}`, { requestId: `req-pre-spawn-${item.name}` }))).resolves.toMatchObject({
        state: 'FAILED',
        reasonCode: item.reasonCode,
      })
      expect(factory.transports).toHaveLength(1)
      expect(factory.transports[0].startOptions).toBeUndefined()
      expect(factory.transports[0].newSessionCalls).toBe(0)
    }
  })

  it('declares mediated fs and terminal, reads/writes only allowlisted files, and emits candidate digest without public paths', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const kimiCodeHome = isolatedKimiCodeHome()
    const factory = new FakeTransportFactory(async (transport) => {
      expect(await transport.reverse('fs/read_text_file', { path: 'a.txt' })).toEqual({ content: 'before' })
      expect(await transport.reverse('fs/read_text_file', { path: join(root, 'a.txt') })).toEqual({ content: 'before' })
      for (const method of ['terminal/create', 'terminal/wait_for_exit', 'terminal/output', 'terminal/release', 'terminal/kill']) {
        await expect(() => transport.reverse(method, { sessionId: 'terminal-session' })).rejects.toThrow()
      }
      await transport.reverse('fs/write_text_file', { path: join(root, 'a.txt'), content: 'after' })
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root, ['a.txt'], undefined, kimiCodeHome),
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const previousKimiCodeHome = process.env.KIMI_CODE_HOME
    const previousKimiLegacyFlag = process.env.KIMI_CODE_LEGACY_FLAG
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    process.env.KIMI_CODE_HOME = join(tmpdir(), 'xiaogui-inherited-kimi-home')
    process.env.KIMI_CODE_LEGACY_FLAG = '0'
    process.env.HOME = join(tmpdir(), 'xiaogui-inherited-home')
    process.env.USERPROFILE = join(tmpdir(), 'xiaogui-inherited-userprofile')

    try {
      const created = await adapter.createOrResume(request(root))
      expect(created).toMatchObject({ state: 'READY' })
      expect(factory.createCalls[0]).toMatchObject({
        args: ['acp'],
        cwd: root,
        env: {
          KIMI_CODE_HOME: kimiCodeHome,
          KIMI_CODE_LEGACY_FLAG: '1',
          HOME: kimiCodeHome,
          USERPROFILE: kimiCodeHome,
        },
      })
      expect(factory.createCalls[0].env).not.toMatchObject({ KIMI_CODE_HOME: process.env.KIMI_CODE_HOME })
      expect(factory.createCalls[0].env).not.toMatchObject({ KIMI_CODE_LEGACY_FLAG: process.env.KIMI_CODE_LEGACY_FLAG })
      expect(factory.createCalls[0].env).not.toMatchObject({ HOME: process.env.HOME })
      expect(factory.createCalls[0].env).not.toMatchObject({ USERPROFILE: process.env.USERPROFILE })
      const transport = factory.transports[0]
      expect(transport.startOptions?.initialize.clientCapabilities).toEqual({
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      })

      await tick()
      let events = await collect(adapter.stream(created.runtimeSessionId, 0))
      const permission = events.find((event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED')
      if (!permission) throw new Error('write permission missing')
      expect(permission).toMatchObject({
        permissionPurpose: 'FILE_WRITE',
        requestedRelativePaths: ['a.txt'],
      })
      await expect(adapter.permission({
        type: 'ALLOW_ONCE',
        permissionRequestId: permission.permissionRequestId,
        challengeDigest: permission.challengeDigest,
        decisionRequestId: 'decision-write-direct',
        scope: request(root).scope,
        runtimeSessionId: created.runtimeSessionId,
        proofId: 'proof-write-direct',
        proofDigest: 'sha256:proof-write-direct',
      })).resolves.toEqual({ accepted: true })
      await tick()
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('after')
      const runtimeSessionId = created.runtimeSessionId
      events = await collect(adapter.stream(runtimeSessionId, 0))
      expect(events.map((event) => event.type)).toEqual(['SESSION_READY', 'PERMISSION_REQUESTED', 'CANDIDATE_PRODUCED', 'RUNTIME_SETTLED'])
      expect(JSON.stringify(events)).not.toContain(root)
      expect(JSON.stringify(events)).not.toContain(kimiCodeHome)
      await expect(adapter.inspect(runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
      await expect(adapter.send({
        requestId: 'send-after-success',
        runtimeSessionId,
        messageKind: 'GUIDANCE',
        messageEnvelopeRef: messageRef(),
      })).resolves.toEqual({ accepted: false, reasonCode: 'RUNTIME_ALREADY_SETTLED' })
      expect(transport.disposeCalls).toBe(1)
    } finally {
      if (previousKimiCodeHome === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = previousKimiCodeHome
      if (previousKimiLegacyFlag === undefined) delete process.env.KIMI_CODE_LEGACY_FLAG
      else process.env.KIMI_CODE_LEGACY_FLAG = previousKimiLegacyFlag
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
    }
  })

  it('requires an adapter-owned ALLOW_ONCE write challenge before a no-vendor-challenge fs write is committed', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const writeTasks: Promise<unknown>[] = []
    const factory = new FakeTransportFactory((transport) => {
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after' }))
      return writeTasks[0].then(() => undefined)
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResume(request(root))
    await tick()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('before')
    const permissionEvent = (await collect(adapter.stream(created.runtimeSessionId, 0))).find(
      (event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED',
    )
    expect(permissionEvent).toMatchObject({
      runtimeSessionId: created.runtimeSessionId,
      decisionRequired: 'ALLOW_ONCE_OR_DENY',
    })
    expect(JSON.stringify(permissionEvent)).not.toContain(root)
    if (!permissionEvent) throw new Error('permission event missing')

    await expect(adapter.permission({
      type: 'ALLOW_ONCE',
      permissionRequestId: permissionEvent.permissionRequestId,
      challengeDigest: permissionEvent.challengeDigest,
      decisionRequestId: 'write-decision-1',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      proofId: 'write-proof-1',
      proofDigest: 'sha256:write-proof',
    })).resolves.toEqual({ accepted: true })
    await expect(writeTasks[0]).resolves.toMatchObject({ contentDigest: digestBytes(Buffer.from('after')) })
    await tick()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('after')
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
  })

  it('binds concurrent write challenges to the original target identity and rejects stale approvals', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const writeTasks: Promise<unknown>[] = []
    const factory = new FakeTransportFactory(async (transport) => {
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after-one' }))
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after-two' }))
      await Promise.allSettled(writeTasks)
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResume(request(root))
    await tick()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('before')
    const permissions = (await collect(adapter.stream(created.runtimeSessionId, 0))).filter(
      (event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED',
    )
    expect(permissions).toHaveLength(2)
    expect(permissions[0].challengeDigest).not.toBe(permissions[1].challengeDigest)

    await expect(adapter.permission({
      type: 'ALLOW_ONCE',
      permissionRequestId: permissions[0].permissionRequestId,
      challengeDigest: permissions[0].challengeDigest,
      decisionRequestId: 'allow-concurrent-write-1',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      proofId: 'concurrent-proof-1',
      proofDigest: 'sha256:concurrent-proof-1',
    })).resolves.toEqual({ accepted: true })
    await expect(writeTasks[0]).resolves.toMatchObject({ contentDigest: digestBytes(Buffer.from('after-one')) })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('after-one')

    await expect(adapter.permission({
      type: 'ALLOW_ONCE',
      permissionRequestId: permissions[1].permissionRequestId,
      challengeDigest: permissions[1].challengeDigest,
      decisionRequestId: 'allow-concurrent-write-2',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      proofId: 'concurrent-proof-2',
      proofDigest: 'sha256:concurrent-proof-2',
    })).resolves.toEqual({ accepted: true })
    await expect(writeTasks[1]).rejects.toThrow()
    await tick()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('after-one')
    const events = await collect(adapter.stream(created.runtimeSessionId, 0))
    expect(events.filter((event) => event.type === 'CANDIDATE_PRODUCED')).toHaveLength(1)
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
  })

  it('does not reuse write permission decisions for denial, proof replay, or another write target', async () => {
    const root = workspace({ 'a.txt': 'before', 'b.txt': 'other' })
    const writeTasks: Promise<unknown>[] = []
    const factory = new FakeTransportFactory(async (transport) => {
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after-denied' }))
      try {
        await writeTasks[0]
      } catch {
        // expected denial
      }
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after' }))
      await writeTasks[1]
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'b.txt', content: 'other-after' }))
      await new Promise<void>(() => {})
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root, ['a.txt', 'b.txt']),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResume(request(root))
    await tick()
    let events = await collect(adapter.stream(created.runtimeSessionId, 0))
    const denied = events.find((event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED')
    if (!denied) throw new Error('deny permission missing')
    await expect(adapter.permission({
      type: 'DENY',
      permissionRequestId: denied.permissionRequestId,
      challengeDigest: denied.challengeDigest,
      decisionRequestId: 'deny-write-1',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      reasonCode: 'USER_DENIED',
    })).resolves.toEqual({ accepted: true })
    await expect(writeTasks[0]).rejects.toThrow()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('before')

    await tick()
    events = await collect(adapter.stream(created.runtimeSessionId, 0))
    const allowed = events.filter((event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED')[1]
    if (!allowed) throw new Error('allow permission missing')
    const allowDecision = {
      type: 'ALLOW_ONCE',
      permissionRequestId: allowed.permissionRequestId,
      challengeDigest: allowed.challengeDigest,
      decisionRequestId: 'allow-write-1',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      proofId: 'write-proof-1',
      proofDigest: 'sha256:write-proof',
    } as const
    await expect(adapter.permission(allowDecision)).resolves.toEqual({ accepted: true })
    await expect(adapter.permission({ ...allowDecision, decisionRequestId: 'allow-write-replay' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_REQUEST_CONSUMED',
    })
    await expect(writeTasks[1]).resolves.toMatchObject({ contentDigest: digestBytes(Buffer.from('after')) })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('after')

    await tick()
    events = await collect(adapter.stream(created.runtimeSessionId, 0))
    const crossTarget = events.filter((event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED')[2]
    if (!crossTarget) throw new Error('cross-target permission missing')
    await expect(adapter.permission({ ...allowDecision, permissionRequestId: crossTarget.permissionRequestId, challengeDigest: crossTarget.challengeDigest, decisionRequestId: 'allow-cross-target' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_PROOF_REPLAYED',
    })
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('other')
  })

  it('queues guidance FIFO behind the active prompt and settles only after the final turn', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const releases: Array<() => void> = []
    const factory = new FakeTransportFactory(() => new Promise<void>((resolve) => releases.push(resolve)))
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver('initial prompt'),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResume(request(root, 'initial prompt'))
    expect(factory.transports[0].prompts).toEqual([[{ type: 'text', text: 'initial prompt' }]])
    await expect(adapter.send({
      requestId: 'send-1',
      runtimeSessionId: created.runtimeSessionId,
      messageKind: 'GUIDANCE',
      messageEnvelopeRef: messageRef(),
    })).resolves.toEqual({ accepted: true, requestId: 'send-1' })
    expect(factory.transports[0].promptCalls).toBe(1)
    expect(factory.transports[0].maxConcurrentPromptCalls).toBe(1)

    releases.shift()?.()
    await tick()
    expect(factory.transports[0].prompts).toEqual([
      [{ type: 'text', text: 'initial prompt' }],
      [{ type: 'text', text: 'guidance text' }],
    ])
    expect(factory.transports[0].disposeCalls).toBe(0)
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_STILL_RUNNING' })

    releases.shift()?.()
    await tick()
    expect(factory.transports[0].maxConcurrentPromptCalls).toBe(1)
    expect(factory.transports[0].disposeCalls).toBe(1)
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'CANDIDATE_NOT_PRODUCED' })
  })

  it('runs a research role as evidence-only and rejects every write before permission', async () => {
    const root = workspace({ 'a.txt': 'before' })
    let writeRejected = false
    const factory = new FakeTransportFactory(async (transport, sessionId) => {
      try {
        await transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after' })
      } catch {
        writeRejected = true
      }
      transport.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '只读研究结论' },
        },
      })
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
      productionGate: { enabled: true, selection: productionSelection },
    })

    const created = await adapter.createOrResume(productionRequest(root, {
      codingRole: codingRole('RESEARCH'),
    }))
    expect(created).toMatchObject({ state: 'READY' })
    await tick()

    expect(writeRejected).toBe(true)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('before')
    expect(factory.transports[0].startOptions?.initialize.clientCapabilities.fs.writeTextFile).toBe(false)
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
    const events = await collect(adapter.stream(created.runtimeSessionId, 0))
    expect(events.some((event) => event.type === 'PERMISSION_REQUESTED')).toBe(false)
  })

  it('sends resolver-backed guidance text and treats BEST_EFFORT cancel as unconfirmed until Kimi reports cancelled', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const releases: Array<() => void> = []
    const factory = new FakeTransportFactory(() => new Promise<void>((resolve) => releases.push(resolve)))
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const created = await adapter.createOrResume(request(root))
    expect(created).toMatchObject({ state: 'READY' })
    await expect(adapter.send({
      requestId: 'send-1',
      runtimeSessionId: created.runtimeSessionId,
      messageKind: 'GUIDANCE',
      messageEnvelopeRef: messageRef(),
    })).resolves.toEqual({ accepted: true, requestId: 'send-1' })
    expect(factory.transports[0].promptCalls).toBe(1)
    releases.shift()?.()
    await tick()
    expect(factory.transports[0].prompts[1]).toEqual([{ type: 'text', text: 'guidance text' }])

    await expect(adapter.interrupt({ requestId: 'cancel-1', runtimeSessionId: created.runtimeSessionId, reason: 'user_cancelled' })).resolves.toEqual({ requested: true })
    expect(factory.transports[0].cancelCalls).toBe(1)
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_STILL_RUNNING' })

    const mismatchRoot = workspace({ 'a.txt': 'before' })
    const mismatchFactory = new FakeTransportFactory(async () => new Promise<void>(() => {}))
    const mismatchResolver = payloadResolver()
    mismatchResolver.resolveMessage = async (ref) => ({
      messageEnvelopeRef: { ...ref, refId: 'message-other' },
      redactedPreviewDigest: 'sha256:redacted-message',
      payloadBytes: Buffer.from('guidance text', 'utf8'),
    })
    const mismatchAdapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: mismatchResolver,
      workspaceResolver: resolver(mismatchRoot),
      probe: new FakeProbe(),
      transportFactory: mismatchFactory,
    })
    const mismatchCreated = await mismatchAdapter.createOrResume(request(mismatchRoot))
    expect(mismatchCreated).toMatchObject({ state: 'READY' })
    const promptCallsBeforeSend = mismatchFactory.transports[0].promptCalls
    await expect(mismatchAdapter.send({
      requestId: 'send-mismatch',
      runtimeSessionId: mismatchCreated.runtimeSessionId,
      messageKind: 'GUIDANCE',
      messageEnvelopeRef: messageRef(),
    })).resolves.toEqual({ accepted: false, reasonCode: 'MESSAGE_REF_MISMATCH' })
    expect(mismatchFactory.transports[0].promptCalls).toBe(promptCallsBeforeSend)
  })

  it('clears pending write permission on cancel and rejects late allow without writing', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const writeTasks: Promise<unknown>[] = []
    const factory = new FakeTransportFactory(async (transport) => {
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after-cancel' }))
      await writeTasks[0].catch(() => undefined)
      await new Promise<void>(() => {})
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResume(request(root))
    await tick()
    const permission = (await collect(adapter.stream(created.runtimeSessionId, 0))).find(
      (event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED',
    )
    if (!permission) throw new Error('permission event missing')
    await expect(adapter.interrupt({ requestId: 'cancel-write', runtimeSessionId: created.runtimeSessionId, reason: 'user_cancelled' })).resolves.toEqual({ requested: true })
    await expect(adapter.permission({
      type: 'ALLOW_ONCE',
      permissionRequestId: permission.permissionRequestId,
      challengeDigest: permission.challengeDigest,
      decisionRequestId: 'late-allow',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      proofId: 'late-proof',
      proofDigest: 'sha256:late-proof',
    })).resolves.toEqual({ accepted: false, reasonCode: 'RUNTIME_CANCEL_REQUESTED' })
    await expect(writeTasks[0]).rejects.toThrow()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('before')
  })

  it('settles a produced candidate as succeeded when Kimi ends the turn after a best-effort cancel request', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const releasePrompt: Array<() => void> = []
    const writeTasks: Promise<unknown>[] = []
    const factory = new FakeTransportFactory(async (transport) => {
      writeTasks.push(transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after' }))
      await writeTasks[0]
      await new Promise<void>((resolve) => releasePrompt.push(resolve))
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResume(request(root))
    await tick()
    const permission = (await collect(adapter.stream(created.runtimeSessionId, 0))).find(
      (event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED',
    )
    if (!permission) throw new Error('permission event missing')
    await expect(adapter.permission({
      type: 'ALLOW_ONCE',
      permissionRequestId: permission.permissionRequestId,
      challengeDigest: permission.challengeDigest,
      decisionRequestId: 'allow-before-best-effort-cancel',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      proofId: 'proof-before-best-effort-cancel',
      proofDigest: 'sha256:proof-before-best-effort-cancel',
    })).resolves.toEqual({ accepted: true })
    await expect(writeTasks[0]).resolves.toMatchObject({ contentDigest: digestBytes(Buffer.from('after')) })

    await expect(adapter.interrupt({ requestId: 'best-effort-cancel-after-candidate', runtimeSessionId: created.runtimeSessionId, reason: 'user_cancelled' })).resolves.toEqual({ requested: true })
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'RUNTIME_STILL_RUNNING' })
    releasePrompt.shift()?.()
    await tick()

    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
    const events = await collect(adapter.stream(created.runtimeSessionId, 0))
    expect(events.filter((event) => event.type === 'RUNTIME_SETTLED')).toHaveLength(1)
    expect(events.find((event) => event.type === 'RUNTIME_SETTLED')).toMatchObject({ outcome: 'SUCCEEDED' })
  })

  it('replays identical createOrResume requests and rejects same-key payload drift before starting another ACP session', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory()
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const firstRequest = request(root)
    const first = await adapter.createOrResume(firstRequest)
    await expect(adapter.createOrResume(firstRequest)).resolves.toEqual(first)
    await expect(adapter.createOrResume(request(root, 'edit safely', {
      workspace: { ...firstRequest.workspace, baseRevisionDigest: 'sha256:drift' },
    }))).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'IDEMPOTENCY_CONFLICT' })
    expect(factory.transports).toHaveLength(1)
  })

  it('closes active transports exactly once and rejects new sessions after shutdown', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory(async () => {
      await new Promise<void>(() => {})
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    await expect(adapter.createOrResume(request(root))).resolves.toMatchObject({ state: 'READY' })
    expect(factory.transports).toHaveLength(1)
    expect(factory.transports[0].disposeCalls).toBe(0)

    const firstClose = adapter.close()
    const secondClose = adapter.close()
    expect(secondClose).toBe(firstClose)
    await firstClose

    expect(factory.transports[0].disposeCalls).toBe(1)
    await expect(adapter.discover()).resolves.toMatchObject([
      { health: 'UNAVAILABLE', canCreateSession: false, reasonCode: 'KIMI_ADAPTER_CLOSED' },
    ])
    await expect(adapter.createOrResume(request(root, 'after close', { requestId: 'req-after-close' }))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'KIMI_ADAPTER_CLOSED',
    })
    expect(factory.transports).toHaveLength(1)
  })

  it('fails closed for traversal, absolute paths, aliases, hardlinks, and digest drift before writing', async () => {
    const root = workspace({ 'a.txt': 'before', 'b.txt': 'other' })
    const factory = new FakeTransportFactory(async (transport) => {
      for (const badPath of ['../a.txt', ' C.txt', 'C:\\tmp\\a.txt', 'C:tmp\\a.txt', '\\\\server\\share\\a.txt', '\\\\?\\C:\\tmp\\a.txt', 'a.txt:ads', join(root, 'b.txt')]) {
        await expect(() => transport.reverse('fs/read_text_file', { path: badPath })).rejects.toThrow()
      }
      writeFileSync(join(root, 'a.txt'), 'drifted')
      await expect(() => transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after' })).rejects.toThrow()
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResume(request(root))
    await tick()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('drifted')
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'CANDIDATE_NOT_PRODUCED' })

    const aliasRoot = workspace({ 'target.txt': 'x' })
    let symlinkCreated = false
    try {
      symlinkSync(join(aliasRoot, 'target.txt'), join(aliasRoot, 'alias.txt'))
      symlinkCreated = true
    } catch {
      symlinkCreated = false
    }
    if (symlinkCreated) {
      const aliasAdapter = new KimiAcpRuntimeAdapterV1({
        payloadResolver: payloadResolver(),
        workspaceResolver: resolver(aliasRoot, ['alias.txt']),
        probe: new FakeProbe(),
        transportFactory: new FakeTransportFactory(),
      })
      await expect(aliasAdapter.createOrResume(request(aliasRoot))).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'WORKSPACE_FILE_ALIAS' })

      const absoluteAliasFactory = new FakeTransportFactory(async (transport) => {
        await expect(() => transport.reverse('fs/read_text_file', { path: join(aliasRoot, 'alias.txt') })).rejects.toThrow()
      })
      const absoluteAliasAdapter = new KimiAcpRuntimeAdapterV1({
        payloadResolver: payloadResolver(),
        workspaceResolver: resolver(aliasRoot, ['target.txt']),
        probe: new FakeProbe(),
        transportFactory: absoluteAliasFactory,
      })
      const absoluteAliasCreated = await absoluteAliasAdapter.createOrResume(request(aliasRoot))
      await tick()
      await expect(absoluteAliasAdapter.inspect(absoluteAliasCreated.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'CANDIDATE_NOT_PRODUCED' })
    }

    const hardlinkRoot = workspace({ 'target.txt': 'x' })
    let hardlinkCreated = false
    try {
      linkSync(join(hardlinkRoot, 'target.txt'), join(hardlinkRoot, 'hardlink.txt'))
      hardlinkCreated = true
    } catch {
      hardlinkCreated = false
    }
    if (hardlinkCreated) {
      const hardlinkAdapter = new KimiAcpRuntimeAdapterV1({
        payloadResolver: payloadResolver(),
        workspaceResolver: resolver(hardlinkRoot, ['target.txt']),
        probe: new FakeProbe(),
        transportFactory: new FakeTransportFactory(),
      })
      await expect(hardlinkAdapter.createOrResume(request(hardlinkRoot))).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'WORKSPACE_FILE_HARDLINK' })
    }
  })

  it('binds Kimi early partial file permissions to cached tool kind and denies execute tools', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory(async (transport, sessionId) => {
      transport.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Edit',
          kind: 'edit',
          status: 'pending',
        },
      })
      const permission = transport.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Edit',
          content: [{ type: 'diff', path: join(root, 'a.txt'), oldText: 'before', newText: 'after' }],
        },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      await permission
      transport.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          title: 'Editing a.txt',
          kind: 'edit',
          status: 'in_progress',
          rawInput: { path: 'a.txt', old_string: 'before', new_string: 'after' },
          locations: [{ path: join(root, 'a.txt') }],
        },
      })
      await new Promise<void>(() => {})
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const created = await adapter.createOrResume(request(root))
    await tick()
    const [permissionEvent] = (await collect(adapter.stream(created.runtimeSessionId, 0))).filter(
      (event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED',
    )
    expect(permissionEvent).toMatchObject({
      decisionRequired: 'ALLOW_ONCE_OR_DENY',
      permissionPurpose: 'APPROVED_FILE_TOOL',
      requestedRelativePaths: ['a.txt'],
    })
    const decision = {
      type: 'ALLOW_ONCE',
      permissionRequestId: permissionEvent.permissionRequestId,
      challengeDigest: permissionEvent.challengeDigest,
      decisionRequestId: 'decision-1',
      scope: request(root).scope,
      runtimeSessionId: created.runtimeSessionId,
      proofId: 'proof-1',
      proofDigest: 'sha256:proof',
    } as const
    await expect(adapter.permission(decision)).resolves.toEqual({ accepted: true })
    await expect(adapter.permission(decision)).resolves.toEqual({ accepted: true })
    await expect(adapter.permission({ ...decision, decisionRequestId: 'decision-2' })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_REQUEST_CONSUMED',
    })
    await expect(adapter.permission({ ...decision, decisionRequestId: 'decision-3', scope: { ...decision.scope, attemptId: 'attempt-other' } })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PERMISSION_SCOPE_MISMATCH',
    })

    const denyRoot = workspace({ 'a.txt': 'before' })
    const denyFactory = new FakeTransportFactory(async (transport, sessionId) => {
      transport.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-2',
          title: 'Writing a.txt',
          kind: 'edit',
          status: 'in_progress',
          rawInput: { path: 'a.txt', content: 'after' },
          locations: [{ path: join(denyRoot, 'a.txt') }],
        },
      })
      const result = await transport.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: 'tool-2',
          title: 'Write',
          content: [{ type: 'diff', path: join(denyRoot, 'a.txt'), oldText: 'before', newText: 'after' }],
        },
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'forever', kind: 'allow_always' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      })
      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
      transport.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-terminal',
          title: 'Running a command',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { path: 'a.txt', command: 'unsafe' },
          locations: [{ path: join(denyRoot, 'a.txt') }],
        },
      })
      await expect(transport.requestPermission({
        sessionId,
        toolCall: {
          toolCallId: 'tool-terminal',
          title: 'Shell',
          content: [{ type: 'diff', path: join(denyRoot, 'a.txt'), oldText: 'before', newText: 'after' }],
        },
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      })).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    })
    const denyAdapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(denyRoot),
      probe: new FakeProbe(),
      transportFactory: denyFactory,
    })
    const denied = await denyAdapter.createOrResume(request(denyRoot))
    await tick()
    const deniedEvents = await collect(denyAdapter.stream(denied.runtimeSessionId, 0))
    const ready = deniedEvents.find((event) => event.type === 'SESSION_READY')
    const permission = deniedEvents.find((event) => event.type === 'PERMISSION_REQUESTED')
    expect(ready).toMatchObject({ type: 'SESSION_READY' })
    expect(permission).toMatchObject({ type: 'PERMISSION_REQUESTED', decisionRequired: 'ALLOW_ONCE_OR_DENY' })
    if (permission?.type !== 'PERMISSION_REQUESTED') throw new Error('permission event missing')
    await expect(denyAdapter.permission({
      type: 'DENY',
      permissionRequestId: permission.permissionRequestId,
      challengeDigest: permission.challengeDigest,
      decisionRequestId: 'deny-1',
      scope: request(denyRoot).scope,
      runtimeSessionId: denied.runtimeSessionId,
      reasonCode: 'USER_DENIED',
    })).resolves.toEqual({ accepted: true })
    await tick()
    const unknown = (await collect(denyAdapter.stream(denied.runtimeSessionId, 0))).find(
      (event) => event.type === 'OUTCOME_UNKNOWN',
    )
    expect(unknown).toMatchObject({ type: 'OUTCOME_UNKNOWN', reasonCode: 'CANDIDATE_NOT_PRODUCED' })
  })

  it('uses session/load for an internal resume id and maps disconnects to a single OUTCOME_UNKNOWN', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory((transport) => transport.disconnect('PROCESS_DISCONNECTED'))
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root, ['a.txt'], 'vendor-session-previous'),
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const created = await adapter.createOrResume(request(root))
    expect(factory.transports[0].newSessionCalls).toBe(0)
    expect(factory.transports[0].loadSessionCalls).toHaveLength(1)
    await tick()
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'PROCESS_DISCONNECTED' })
    expect(factory.transports[0].disposeCalls).toBe(1)
    await expect(adapter.send({
      requestId: 'send-after-disconnect',
      runtimeSessionId: created.runtimeSessionId,
      messageKind: 'GUIDANCE',
      messageEnvelopeRef: messageRef(),
    })).resolves.toEqual({
      accepted: false,
      reasonCode: 'PROCESS_DISCONNECTED',
    })
  })

  it('fails closed on malformed ACP process JSON-RPC output', async () => {
    const transport = new NdjsonAcpProcessTransportV1(
      process.execPath,
      ['-e', 'process.stdout.write("not-json\\n")'],
      process.cwd(),
    )
    let disconnectReason = ''

    await expect(transport.start({
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
      onDisconnect(reasonCode) {
        disconnectReason = reasonCode
      },
    })).rejects.toThrow()
    expect(disconnectReason).toBe('ACP_MALFORMED_MESSAGE')
  })
})
