import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({
  app: { getAppPath: () => 'D:/app', getPath: () => 'D:/user-data', isPackaged: false },
  utilityProcess: { fork: mocks.fork },
}))
import { OfficeGatewaySupervisorV1 } from './gateway-supervisor'

const head = `sha256:${'1'.repeat(64)}`
class Child extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
}
const children: Child[] = []
beforeEach(() => {
  mocks.fork.mockImplementation(() => {
    const child = new Child()
    children.push(child)
    queueMicrotask(() => child.emit('message', { type: 'XIAOGUI_OFFICE_GATEWAY_READY_V1', origin: 'http://127.0.0.1:23456', headSha256: head }))
    return child
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ headSha256: head, snapshot: {} }) }))
})
afterEach(() => {
  for (const child of children.splice(0)) child.emit('exit', 0)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Office 工作副本子进程所有权', () => {
  it('不同 supervisor 不得同时拥有同一持久化文件，退出前不能重开', async () => {
    const first = new OfficeGatewaySupervisorV1()
    const second = new OfficeGatewaySupervisorV1()
    const options = { persistenceKey: 'a'.repeat(64), persistenceRoot: 'D:/synthetic-office' }
    const session = await first.start(options)
    await expect(second.start(options)).rejects.toThrow('OFFICE_WORKTREE_ALREADY_OPEN')
    const closing = session.close()
    expect(children[0].postMessage).toHaveBeenCalled()
    await expect(second.start(options)).rejects.toThrow('OFFICE_WORKTREE_ALREADY_OPEN')
    children[0].emit('exit', 0)
    await closing
    await expect(second.start(options)).resolves.toMatchObject({ headSha256: head })
  })

  it('相同 key 的不同持久化根目录互不阻塞；崩溃退出后可重开', async () => {
    const supervisor = new OfficeGatewaySupervisorV1()
    const options = { persistenceKey: 'b'.repeat(64), persistenceRoot: 'D:/office-one' }
    await supervisor.start(options)
    await expect(supervisor.start({ ...options, persistenceRoot: 'D:/office-two' })).resolves.toBeDefined()
    children[0].emit('exit', 1)
    await expect(supervisor.start(options)).resolves.toBeDefined()
  })

  it('fork 失败后释放所有权，允许重试', async () => {
    mocks.fork.mockImplementationOnce(() => { throw new Error('synthetic fork failure') })
    const supervisor = new OfficeGatewaySupervisorV1()
    const options = { persistenceKey: 'c'.repeat(64), persistenceRoot: 'D:/office-three' }
    await expect(supervisor.start(options)).rejects.toThrow('synthetic fork failure')
    await expect(supervisor.start(options)).resolves.toBeDefined()
  })
})
