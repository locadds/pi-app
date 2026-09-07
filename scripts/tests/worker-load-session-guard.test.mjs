import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
/** Normalize CRLF so regex contracts match on Windows CI checkouts. */
const src = (relativePath) => readFileSync(join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')

describe('worker loadSession guard', () => {
  it('handleLoadsession refuses to dispose while agent turn is active on another file', () => {
    const handler = src('src/worker/handlers/worker-handlers-session.ts')
    const binding = src('src/worker/xiaogui-prompt/session-binding.ts')
    assert.match(handler, /const busy = isSessionBusy\(\)/)
    assert.match(handler, /decideXiaoguiPromptContextTransitionV1\(\{/)
    assert.match(handler, /busy: sameSession \? busy : msg\.force !== true && busy/)
    assert.match(binding, /if \(input\.busy\) throw new Error\('WORKER_AGENT_BUSY'\)/)
  })

  it('session.prepare remains disk-only while recording only a trusted pending binding', () => {
    const text = src('src/main/ipc/handlers/session.ts')
    const prepareStart = text.indexOf("ipc:session.prepare")
    const prepareEnd = text.indexOf('ipc:session.setEphemeralDraft')
    assert.ok(prepareStart >= 0 && prepareEnd > prepareStart, 'prepare handler markers')
    const prepareBlock = text.slice(prepareStart, prepareEnd)
    assert.doesNotMatch(prepareBlock, /loadSession|ensureSessionWorker|workerManager\.start/)
    assert.match(prepareBlock, /discoverTrustedSessions\(req\.workspaceId\)/)
    assert.match(prepareBlock, /resolvePreparedSessionFile\(sessionFile, async \(\) => discovery\.sessions\)/)
    assert.match(prepareBlock, /trustedSessionAccessV1\.open\(\{[\s\S]*workspaceId: req\.workspaceId,[\s\S]*sessionFile: prepared\.sessionFile/)
    assert.match(prepareBlock, /setPendingWorkerSessionBinding\(authorized\.binding\)/)
  })

  it('prompt marks agentTurnActive before asynchronously awaiting session.prompt', () => {
    const text = src('src/worker/handlers/worker-handlers-turn.ts')
    const promptIdx = text.indexOf('st.promptSent = true')
    const alreadyIdx = text.indexOf('const alreadyStreaming')
    const activeIdx = text.indexOf('st.agentTurnActive = true', promptIdx)
    const awaitIdx = text.indexOf('await promptSession.prompt', promptIdx)
    assert.ok(promptIdx >= 0 && alreadyIdx >= 0 && activeIdx > promptIdx && awaitIdx > activeIdx)
    assert.match(text, /createXiaoguiPromptAssemblyGateV1\(/)
    assert.match(text, /alreadyStreaming && !gated\.streamingBehavior/)
    assert.match(text, /await promptSession\.prompt\(promptText, merged\)/)
  })

  it('workerManager keeps session-specific RPCs off the foreground and refreshes only the trusted visible slot', () => {
    const text = src('src/main/worker-manager.ts')
    const resolveStart = text.indexOf('private async resolveSlotForRpc')
    const resolveEnd = text.indexOf('private request(', resolveStart)
    assert.ok(resolveStart >= 0 && resolveEnd > resolveStart, 'RPC resolver markers')
    const resolver = text.slice(resolveStart, resolveEnd)
    const sessionBranch = resolver.slice(0, resolver.indexOf('const slot = this.foregroundSlot()'))
    assert.doesNotMatch(sessionBranch, /setForeground/)
    assert.match(sessionBranch, /resolveRegisteredSessionBinding\(sessionFile\)/)
    assert.match(sessionBranch, /ensureSessionWorkerUnlocked\(binding\)/)
    assert.match(resolver, /const \{ sessionFile: foregroundSessionFile \} = slot/)
    assert.match(resolver, /slot\.sessionBinding \?\? this\.resolveRegisteredSessionBinding\(foregroundSessionFile\)/)
    assert.match(resolver, /this\.setForeground\(refreshed\)/)
    assert.match(text, /focusExistingSession\(sessionFile: string\)/)
    assert.match(text, /focusSessionWorker\(\s*binding: TrustedSessionBindingHandleV1/)
  })

  it('getState reflects agent turn activity for runtime snapshot', () => {
    const text = src('src/worker/handlers/worker-handlers-catalog.ts')
    assert.match(text, /isStreaming:\s*st\.session\.isStreaming\s*\|\|\s*st\.agentTurnActive/)
  })

  it('runExtensionCommand passes streamingBehavior when agent is streaming', () => {
    const text = src('src/worker/handlers/worker-handlers-session.ts')
    assert.match(text, /streamingBehavior:\s*'followUp'/)
  })
})
