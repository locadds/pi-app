import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  RuntimeAdapterSelectionV1,
  RuntimeContractTestCreateOrResumeRequestV1,
  RuntimeContractTestPolicyV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimeProductionPolicyV1,
  RuntimeTestAdapterSelectionV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

import type {
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpSessionUpdateParamsV1,
  AcpTransportCreateOptionsV1,
  AcpTransportFactoryV1,
  AcpTransportStartOptionsV1,
  AcpTransportV1,
} from './acp/types'
import { AcpProcessTransportFactoryV1 } from './acp/process-transport'
import { digestBytes } from './acp/workspace-policy'
import {
  createOmpAcpRuntimeAdapterV1,
  OmpAcpCliProbeV1,
  OMP_ACP_APPROVED_PACKAGE_V1,
  OMP_ACP_APPROVED_VERSION_V1,
  OMP_ACP_ADAPTER_ID_V1,
  ompAcpCapabilityDigestForVersionV1,
  type OmpAcpWorkspaceResolverV1,
} from './omp-acp-adapter'
import { createAgentRuntimeContractTestHostV1, createAgentRuntimeHostV1 } from './runtime-host'
import { createAgentRuntimeRegistryV1 } from './runtime-registry'

const roots: string[] = []

afterEach(() => {
  // Windows can release SQLite/WAL handles a fraction after the process close
  // event. A bounded retry distinguishes that OS delay from a leaked process.
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

const testSelection = {
  adapterId: OMP_ACP_ADAPTER_ID_V1,
  runtimeKind: 'OTHER',
  protocol: 'ACP',
  capabilityDigest: ompAcpCapabilityDigestForVersionV1(OMP_ACP_APPROVED_VERSION_V1),
  approvalStatus: 'APPROVED_FOR_TEST',
  diagnosticOnly: false,
  stream: 'POLL',
  interrupt: 'BEST_EFFORT',
  inspect: 'SNAPSHOT',
} satisfies RuntimeTestAdapterSelectionV1

const contractTestPolicy = {
  rejectDiagnosticOnly: true,
  workspacePolicy: 'ATTEMPT_WORKTREE_ONLY',
  productEnablement: false,
  allowedSelections: [testSelection],
} satisfies RuntimeContractTestPolicyV1

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-omp-acp-'))
  roots.push(root)
  writeFileSync(join(root, 'a.txt'), 'before')
  return root
}

function request(rootPath: string): RuntimeContractTestCreateOrResumeRequestV1 {
  const prompt = Buffer.from('inspect a.txt', 'utf8')
  return {
    executionMode: 'CONTRACT_TEST',
    requestId: 'omp-request-1',
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
    contractTestPolicy,
    promptEnvelopeRef: {
      refId: 'prompt-1',
      digest: digestBytes(prompt),
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
  }
}

function productionRequest(rootPath: string): RuntimeCreateOrResumeRequestV1 {
  const contract = request(rootPath)
  const selection = {
    ...testSelection,
    approvalStatus: 'APPROVED_FOR_PRODUCTION',
  } satisfies RuntimeAdapterSelectionV1
  const policy = {
    rejectDiagnosticOnly: true,
    allowedSelections: [selection],
  } satisfies RuntimeProductionPolicyV1
  return {
    requestId: contract.requestId,
    scope: contract.scope,
    workspace: contract.workspace,
    selection,
    productionPolicy: policy,
    promptEnvelopeRef: contract.promptEnvelopeRef,
  }
}

function workspaceResolver(rootPath: string): OmpAcpWorkspaceResolverV1 {
  return {
    async resolve() {
      return {
        rootPath,
        allowedFiles: [{
          relativePath: 'a.txt',
          contentDigest: digestBytes(Buffer.from(readFileSync(join(rootPath, 'a.txt')))),
        }],
      }
    },
  }
}

function payloadResolver(): TrustedRuntimePayloadResolverV1 {
  return {
    async resolvePrompt(ref) {
      return {
        promptEnvelopeRef: ref,
        redactedPreviewDigest: 'sha256:redacted',
        payloadBytes: Buffer.from('inspect a.txt', 'utf8'),
      }
    },
    async resolveMessage(ref) {
      return {
        messageEnvelopeRef: ref,
        redactedPreviewDigest: 'sha256:redacted-message',
        payloadBytes: Buffer.from('continue', 'utf8'),
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
      return { changeSetCandidateId: 'unused', digest: input.candidateDigest }
    },
  }
}

class FakeProbe {
  constructor(private readonly version = OMP_ACP_APPROVED_VERSION_V1) {}

  async findExecutable() {
    return {
      available: true as const,
      command: 'omp',
      args: ['--approval-mode', 'always-ask', '--no-extensions', '--no-skills', '--no-rules', 'acp'],
      version: this.version,
    }
  }
}

class FakeTransport implements AcpTransportV1 {
  startOptions?: AcpTransportStartOptionsV1
  disposeCalls = 0
  promptCalls = 0

  constructor(
    private readonly script?: (transport: FakeTransport) => Promise<void> | void,
  ) {}

  async start(options: AcpTransportStartOptionsV1) {
    this.startOptions = options
    return {
      protocolVersion: 1,
      agentInfo: { name: 'oh-my-pi', version: OMP_ACP_APPROVED_VERSION_V1 },
      agentCapabilities: { loadSession: true },
    }
  }

  async newSession() {
    return { sessionId: 'omp-vendor-session-1' }
  }

  async loadSession() {}

  async prompt() {
    this.promptCalls += 1
    await this.script?.(this)
    return { stopReason: 'end_turn' }
  }

  async cancel() {}

  async dispose() {
    this.disposeCalls += 1
  }

  sessionUpdate(params: AcpSessionUpdateParamsV1) {
    this.startOptions?.onSessionUpdate(params)
  }

  requestPermission(params: AcpRequestPermissionParamsV1) {
    if (!this.startOptions) throw new Error('transport not started')
    return this.startOptions.onPermissionRequest(params)
  }
}

class FakeTransportFactory implements AcpTransportFactoryV1 {
  readonly createCalls: Array<{
    command: string
    args: readonly string[]
    cwd: string
    env?: Readonly<Record<string, string>>
  }> = []
  readonly transports: FakeTransport[] = []

  constructor(
    private readonly script?: (transport: FakeTransport) => Promise<void> | void,
  ) {}

  create(command: string, args: readonly string[], cwd: string, _options?: AcpTransportCreateOptionsV1) {
    this.createCalls.push({ command, args, cwd, env: _options?.env })
    const transport = new FakeTransport(this.script)
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

const realOmpAcpIt = process.env.XIAOGUI_OMP_ACP_REAL_SMOKE === '1' ? it : it.skip

describe('Oh My Pi ACP runtime adapter test gate', () => {
  it('pins the fail-closed ACP flags in the real executable probe', async () => {
    const previous = process.env.OMP_CLI_PATH
    process.env.OMP_CLI_PATH = process.execPath
    try {
      const launch = await new OmpAcpCliProbeV1().findExecutable()
      expect(launch).toMatchObject({
        available: true,
        command: process.execPath,
        args: ['--approval-mode', 'always-ask', '--no-extensions', '--no-skills', '--no-rules', 'acp'],
      })
    } finally {
      if (previous === undefined) delete process.env.OMP_CLI_PATH
      else process.env.OMP_CLI_PATH = previous
    }
  })

  realOmpAcpIt('discovers the pinned bunx package and completes a real sanitized ACP handshake', async () => {
    const previousCliPath = process.env.OMP_CLI_PATH
    delete process.env.OMP_CLI_PATH
    process.env.XIAOGUI_OMP_ACP_BUNX_TEST_ENABLED = '1'
    const root = workspace()
    const stateDir = join(root, 'omp-state')
    let transport: AcpTransportV1 | undefined
    try {
      const launch = await new OmpAcpCliProbeV1().findExecutable()
      expect(launch).toMatchObject({
        available: true,
        version: OMP_ACP_APPROVED_VERSION_V1,
      })
      if (!launch.available) throw new Error(launch.reasonCode)
      expect(launch.args).toEqual([
        '--bun',
        OMP_ACP_APPROVED_PACKAGE_V1,
        '--approval-mode',
        'always-ask',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        'acp',
      ])
      transport = new AcpProcessTransportFactoryV1().create(launch.command, launch.args, root, {
        env: { PI_CODING_AGENT_DIR: stateDir },
      })
      const initialized = await transport.start({
        cwd: root,
        initialize: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
            elicitation: { form: {} },
          },
          clientInfo: { name: 'xiaogui-omp-acp-real-smoke', version: '0.1.0' },
        },
        requestHandlers: new Map(),
        onSessionUpdate: () => undefined,
        onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
        onDisconnect: () => undefined,
      })
      expect(initialized).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: 'oh-my-pi', version: OMP_ACP_APPROVED_VERSION_V1 },
        agentCapabilities: { loadSession: true },
      })
      const session = await transport.newSession(root)
      expect(session.sessionId).toEqual(expect.any(String))
      expect(session.sessionId.length).toBeGreaterThan(8)
      console.info(JSON.stringify({
        event: 'omp-acp-real-smoke',
        launch: `bunx --bun ${OMP_ACP_APPROVED_PACKAGE_V1}`,
        protocolVersion: initialized.protocolVersion,
        agentInfo: initialized.agentInfo,
        loadSession: initialized.agentCapabilities?.loadSession === true,
        sessionNew: 'ok',
        sessionId: '<redacted>',
      }))
    } finally {
      await transport?.dispose()
      if (previousCliPath === undefined) delete process.env.OMP_CLI_PATH
      else process.env.OMP_CLI_PATH = previousCliPath
    }
  }, 120_000)

  it('registers as test-approved ACP capability but never enters production routing', async () => {
    const root = workspace()
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: workspaceResolver(root),
      runtimeStateDir: root,
      probe: new FakeProbe(),
      transportFactory: new FakeTransportFactory(),
    })
    const registry = createAgentRuntimeRegistryV1()
    await registry.register(adapter)

    await expect(registry.discover()).resolves.toMatchObject([{
      adapterId: OMP_ACP_ADAPTER_ID_V1,
      runtimeKind: 'OTHER',
      protocol: 'ACP',
      approvalStatus: 'APPROVED_FOR_TEST',
      health: 'AVAILABLE',
      interactivePermission: 'HOST_MEDIATED',
    }])
    await expect(registry.resolve({
      mode: 'CODING',
      requiredCapabilities: ['CODING.GIT.CHANGESET'],
      dataEgressPolicy: 'EXTERNAL_ALLOWED',
      priorityAdapterIds: [OMP_ACP_ADAPTER_ID_V1],
      requireProductionApproval: true,
    })).resolves.toMatchObject({ ok: false, reasonCode: 'NO_APPROVED_RUNTIME' })
    await expect(createAgentRuntimeHostV1(adapter).createOrResume(productionRequest(root))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'OMP_PRODUCTION_DISABLED',
    })
    await registry.close()
  })

  it('launches the pinned ACP process with fail-closed flags and maps evidence to runtime events', async () => {
    const root = workspace()
    const factory = new FakeTransportFactory((transport) => {
      transport.sessionUpdate({
        sessionId: 'omp-vendor-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'inspection complete' },
        },
      })
    })
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: workspaceResolver(root),
      runtimeStateDir: root,
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const outcome = await createAgentRuntimeContractTestHostV1(adapter).createOrResume(request(root))
    expect(outcome).toMatchObject({ state: 'READY' })
    expect(factory.createCalls).toEqual([{
      command: 'omp',
      args: ['--approval-mode', 'always-ask', '--no-extensions', '--no-skills', '--no-rules', 'acp'],
      cwd: root,
      env: { PI_CODING_AGENT_DIR: root },
    }])

    await tick()
    const runtimeSessionId = 'runtimeSessionId' in outcome ? outcome.runtimeSessionId : ''
    const events = await collect(adapter.stream(runtimeSessionId, 0))
    expect(events.map((event) => event.type)).toEqual([
      'SESSION_READY',
      'TEXT_DELTA',
      'CANDIDATE_PRODUCED',
      'RUNTIME_SETTLED',
    ])
    await expect(adapter.inspect(runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
    expect(factory.transports[0].disposeCalls).toBe(1)
  })

  it('forwards only allow-once permission and never exposes an absolute workspace path', async () => {
    const root = workspace()
    let permissionResult: AcpRequestPermissionResultV1 | undefined
    const factory = new FakeTransportFactory(async (transport) => {
      permissionResult = await transport.requestPermission({
        sessionId: 'omp-vendor-session-1',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'edit',
          // Human-readable titles are not authority for permission routing.
          title: 'Execute command',
          locations: [{ path: join(root, 'a.txt'), line: 1 }],
        },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'allow-always', kind: 'allow_always' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      transport.sessionUpdate({
        sessionId: 'omp-vendor-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'approved result' },
        },
      })
    })
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: workspaceResolver(root),
      runtimeStateDir: root,
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const outcome = await createAgentRuntimeContractTestHostV1(adapter).createOrResume(request(root))
    const runtimeSessionId = 'runtimeSessionId' in outcome ? outcome.runtimeSessionId : ''
    await tick()
    const events = await collect(adapter.stream(runtimeSessionId, 0))
    const permission = events.find((event) => event.type === 'PERMISSION_REQUESTED')
    expect(permission).toMatchObject({
      permissionPurpose: 'FILE_WRITE',
      requestedRelativePaths: ['a.txt'],
    })
    expect(JSON.stringify(permission)).not.toContain(root)
    if (!permission || permission.type !== 'PERMISSION_REQUESTED') throw new Error('permission event missing')

    await expect(adapter.permission({
      type: 'ALLOW_ONCE',
      permissionRequestId: permission.permissionRequestId,
      challengeDigest: permission.challengeDigest,
      decisionRequestId: 'decision-1',
      scope: permission.scope,
      runtimeSessionId,
      proofId: 'proof-1',
      proofDigest: 'sha256:proof',
    })).resolves.toEqual({ accepted: true })
    await tick()
    expect(permissionResult).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    await expect(adapter.inspect(runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
  })

  it('rejects unapproved versions and cancels permission targets outside the attempt worktree', async () => {
    const root = workspace()
    const unapproved = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: workspaceResolver(root),
      runtimeStateDir: root,
      probe: new FakeProbe('18.1.3'),
      transportFactory: new FakeTransportFactory(),
    })
    await expect(unapproved.discover()).resolves.toMatchObject([{
      health: 'UNAVAILABLE',
      reasonCode: 'OMP_VERSION_UNAPPROVED',
    }])

    let outsideResult: AcpRequestPermissionResultV1 | undefined
    const factory = new FakeTransportFactory(async (transport) => {
      outsideResult = await transport.requestPermission({
        sessionId: 'omp-vendor-session-1',
        toolCall: {
          toolCallId: 'tool-2',
          kind: 'edit',
          locations: [{ path: join(root, '..', 'outside.txt') }],
        },
        options: [{ optionId: 'allow-once', kind: 'allow_once' }],
      })
      transport.sessionUpdate({
        sessionId: 'omp-vendor-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'outside denied' },
        },
      })
    })
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: workspaceResolver(root),
      runtimeStateDir: root,
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const outcome = await createAgentRuntimeContractTestHostV1(adapter).createOrResume(request(root))
    const runtimeSessionId = 'runtimeSessionId' in outcome ? outcome.runtimeSessionId : ''
    await tick()
    expect(outsideResult).toEqual({ outcome: { outcome: 'cancelled' } })
    expect((await collect(adapter.stream(runtimeSessionId, 0))).some((event) => event.type === 'PERMISSION_REQUESTED')).toBe(false)
  })

  it('ignores updates and rejects permission requests from a different ACP session', async () => {
    const root = workspace()
    let permissionResult: AcpRequestPermissionResultV1 | undefined
    const factory = new FakeTransportFactory(async (transport) => {
      transport.sessionUpdate({
        sessionId: 'different-vendor-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'wrong session evidence' },
        },
      })
      permissionResult = await transport.requestPermission({
        sessionId: 'different-vendor-session',
        toolCall: { toolCallId: 'wrong-session-tool', kind: 'edit', locations: [{ path: 'a.txt' }] },
        options: [{ optionId: 'allow-once', kind: 'allow_once' }],
      })
    })
    const adapter = createOmpAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: workspaceResolver(root),
      runtimeStateDir: root,
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const outcome = await createAgentRuntimeContractTestHostV1(adapter).createOrResume(request(root))
    const runtimeSessionId = 'runtimeSessionId' in outcome ? outcome.runtimeSessionId : ''
    await tick()

    expect(permissionResult).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await collect(adapter.stream(runtimeSessionId, 0))).toEqual([
      expect.objectContaining({ type: 'SESSION_READY' }),
      expect.objectContaining({ type: 'OUTCOME_UNKNOWN', reasonCode: 'OMP_CONTRACT_EVIDENCE_NOT_PRODUCED' }),
    ])
  })
})
