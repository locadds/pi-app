import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  RuntimeAdapterSelectionV1,
  RuntimeCreateOrResumeRequestV1,
  RuntimeEventV1,
  RuntimeProductionPolicyV1,
  TrustedRuntimePayloadResolverV1,
} from '@shared/xiaogui-agent-runtime'

import { createAgentRuntimeHostV1 } from './runtime-host'
import type {
  AcpRequestPermissionParamsV1,
  AcpRequestPermissionResultV1,
  AcpTransportFactoryV1,
  AcpTransportStartOptionsV1,
  AcpTransportV1,
} from './acp/types'
import { NdjsonAcpProcessTransportV1 } from './acp/process-transport'
import { digestBytes } from './acp/workspace-policy'
import {
  createKimiAcpRuntimeAdapterV1,
  KimiAcpCliProbeV1,
  KimiAcpRuntimeAdapterV1,
  kimiAcpCapabilityDigestForVersionV1,
  type KimiAcpCreateOrResumeForTestRequestV1,
  type KimiAcpTestAdapterSelectionV1,
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
} satisfies KimiAcpTestAdapterSelectionV1

const productionSelection = {
  ...testSelection,
  approvalStatus: 'APPROVED_FOR_PRODUCTION',
} satisfies RuntimeAdapterSelectionV1

const productionPolicy = {
  rejectDiagnosticOnly: true,
  allowedSelections: [productionSelection],
} satisfies RuntimeProductionPolicyV1

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'xiaogui-kimi-acp-'))
  roots.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(root, relativePath), content)
  }
  return root
}

function request(rootPath: string, prompt = 'edit safely', overrides: Partial<KimiAcpCreateOrResumeForTestRequestV1> = {}): KimiAcpCreateOrResumeForTestRequestV1 {
  const promptBytes = Buffer.from(prompt, 'utf8')
  return {
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
    productionPolicy,
    promptEnvelopeRef: {
      refId: 'prompt-1',
      digest: digestBytes(promptBytes),
      mediaType: 'application/vnd.xiaogui.runtime-prompt+json',
    },
    ...overrides,
  }
}

function productionRequest(rootPath: string): RuntimeCreateOrResumeRequestV1 {
  const base = request(rootPath)
  return {
    ...base,
    selection: productionSelection,
  }
}

function resolver(rootPath: string, allowed = ['a.txt'], resumeSessionId?: string): KimiAcpWorkspaceResolverV1 {
  return {
    async resolve() {
      return {
        rootPath,
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
  constructor(private readonly available = true) {}

  async findExecutable() {
    return this.available ? ({ available: true as const, command: 'kimi', version: '0.34.0' }) : ({ available: false as const, reasonCode: 'EXECUTABLE_NOT_FOUND' })
  }
}

class FakeAcpTransport implements AcpTransportV1 {
  startOptions?: AcpTransportStartOptionsV1
  newSessionCalls = 0
  loadSessionCalls: Array<{ sessionId: string; cwd: string }> = []
  promptCalls = 0
  disposeCalls = 0
  permissionPromise?: Promise<AcpRequestPermissionResultV1>

  constructor(private readonly script?: (transport: FakeAcpTransport, sessionId: string) => Promise<void> | void) {}

  async start(options: AcpTransportStartOptionsV1) {
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

  async prompt(sessionId: string) {
    this.promptCalls += 1
    await this.script?.(this, sessionId)
    return { stopReason: 'end_turn' }
  }

  async cancel() {}

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

  disconnect(reasonCode = 'PROCESS_DISCONNECTED') {
    this.startOptions?.onDisconnect(reasonCode)
  }
}

class FakeTransportFactory implements AcpTransportFactoryV1 {
  readonly transports: FakeAcpTransport[] = []

  constructor(private readonly script?: (transport: FakeAcpTransport, sessionId: string) => Promise<void> | void) {}

  create(): AcpTransportV1 {
    const transport = new FakeAcpTransport(this.script)
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

  it('discovers only APPROVED_FOR_TEST and cannot be selected through production Host policy', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const adapter = createKimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: new FakeTransportFactory(),
    })
    await expect(adapter.discover()).resolves.toMatchObject([{ approvalStatus: 'APPROVED_FOR_TEST', health: 'AVAILABLE', stream: 'POLL' }])

    const host = createAgentRuntimeHostV1(adapter)
    await expect(host.createOrResume(productionRequest(root))).resolves.toMatchObject({
      state: 'FAILED',
      reasonCode: 'RUNTIME_SELECTION_NOT_KIMI_ACP_TEST',
    })
  })

  it('declares mediated fs and terminal, reads/writes only allowlisted files, and emits candidate digest without public paths', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory(async (transport) => {
      expect(await transport.reverse('fs/read_text_file', { path: 'a.txt' })).toEqual({ content: 'before' })
      for (const method of ['terminal/create', 'terminal/wait_for_exit', 'terminal/output', 'terminal/release', 'terminal/kill']) {
        await expect(() => transport.reverse(method, { sessionId: 'terminal-session' })).rejects.toThrow()
      }
      await transport.reverse('fs/write_text_file', { path: 'a.txt', content: 'after' })
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })

    const created = await adapter.createOrResumeForTest(request(root))
    expect(created).toMatchObject({ state: 'READY' })
    const transport = factory.transports[0]
    expect(transport.startOptions?.initialize.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    })

    await tick()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('after')
    const runtimeSessionId = created.runtimeSessionId
    const events = await collect(adapter.stream(runtimeSessionId, 0))
    expect(events.map((event) => event.type)).toEqual(['SESSION_READY', 'CANDIDATE_PRODUCED', 'RUNTIME_SETTLED'])
    expect(JSON.stringify(events)).not.toContain(root)
    await expect(adapter.inspect(runtimeSessionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
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
    const first = await adapter.createOrResumeForTest(firstRequest)
    await expect(adapter.createOrResumeForTest(firstRequest)).resolves.toEqual(first)
    await expect(adapter.createOrResumeForTest(request(root, 'edit safely', {
      workspace: { ...firstRequest.workspace, baseRevisionDigest: 'sha256:drift' },
    }))).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'IDEMPOTENCY_CONFLICT' })
    expect(factory.transports).toHaveLength(1)
  })

  it('fails closed for traversal, absolute paths, aliases, hardlinks, and digest drift before writing', async () => {
    const root = workspace({ 'a.txt': 'before', 'b.txt': 'other' })
    const factory = new FakeTransportFactory(async (transport) => {
      for (const badPath of ['../a.txt', ' C.txt', 'C:\\tmp\\a.txt', 'a.txt:ads']) {
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

    const created = await adapter.createOrResumeForTest(request(root))
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
      await expect(aliasAdapter.createOrResumeForTest(request(aliasRoot))).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'WORKSPACE_FILE_ALIAS' })
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
      await expect(hardlinkAdapter.createOrResumeForTest(request(hardlinkRoot))).resolves.toMatchObject({ state: 'FAILED', reasonCode: 'WORKSPACE_FILE_HARDLINK' })
    }
  })

  it('bridges permission requests as allow-once or deny only and rejects allow-always options without publishing a challenge', async () => {
    const root = workspace({ 'a.txt': 'before' })
    const factory = new FakeTransportFactory(async (transport, sessionId) => {
      const permission = transport.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'tool-1', kind: 'edit', locations: [{ path: 'a.txt' }] },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      })
      await permission
    })
    const adapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(root),
      probe: new FakeProbe(),
      transportFactory: factory,
    })
    const created = await adapter.createOrResumeForTest(request(root))
    await tick()
    const [permissionEvent] = (await collect(adapter.stream(created.runtimeSessionId, 0))).filter(
      (event): event is Extract<RuntimeEventV1, { type: 'PERMISSION_REQUESTED' }> => event.type === 'PERMISSION_REQUESTED',
    )
    expect(permissionEvent).toMatchObject({ decisionRequired: 'ALLOW_ONCE_OR_DENY' })
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
      const result = await transport.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'tool-2', kind: 'edit', locations: [{ path: 'a.txt' }] },
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'forever', kind: 'allow_always' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      })
      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    })
    const denyAdapter = new KimiAcpRuntimeAdapterV1({
      payloadResolver: payloadResolver(),
      workspaceResolver: resolver(denyRoot),
      probe: new FakeProbe(),
      transportFactory: denyFactory,
    })
    const denied = await denyAdapter.createOrResumeForTest(request(denyRoot))
    await tick()
    const [ready, permission] = await collect(denyAdapter.stream(denied.runtimeSessionId, 0))
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
    const [, , unknown] = await collect(denyAdapter.stream(denied.runtimeSessionId, 0))
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
    const created = await adapter.createOrResumeForTest(request(root))
    expect(factory.transports[0].newSessionCalls).toBe(0)
    expect(factory.transports[0].loadSessionCalls).toHaveLength(1)
    await tick()
    await expect(adapter.inspect(created.runtimeSessionId)).resolves.toMatchObject({ state: 'OUTCOME_UNKNOWN', reasonCode: 'PROCESS_DISCONNECTED' })
    expect(factory.transports[0].disposeCalls).toBe(1)
    await expect(adapter.send({ requestId: 'send-after-disconnect', runtimeSessionId: created.runtimeSessionId, messageKind: 'GUIDANCE', payloadDigest: 'sha256:guidance' })).resolves.toEqual({
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
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
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
