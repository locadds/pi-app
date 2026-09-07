import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startOfficeGatewayV1 } from './server'

const originalWrite = fs.writeFile
const originalRename = fs.rename
beforeEach(() => {
  vi.spyOn(fs, 'writeFile')
  vi.spyOn(fs, 'rename')
})

const headers = { Cookie: `xiaogui_office_test=${'a'.repeat(48)}`, 'Content-Type': 'application/json' }
const initial = { title: '原始工作副本' }
const edited = { title: '编辑后的工作副本' }
type Gateway = Awaited<ReturnType<typeof startOfficeGatewayV1>>
const gateways: Gateway[] = []
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const gateway of gateways.splice(0)) await gateway.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup() {
  await mkdir('D:\\CodexTemp', { recursive: true })
  const root = await mkdtemp('D:\\CodexTemp\\office-save-')
  roots.push(root)
  const path = join(root, 'snapshot.json')
  await writeFile(path, JSON.stringify(initial))
  const options = { sessionCookieName: 'xiaogui_office_test', sessionToken: 'a'.repeat(48), initialSnapshot: initial, snapshotPersistencePath: path }
  const gateway = await startOfficeGatewayV1(options)
  gateways.push(gateway)
  return { root, path, options, gateway }
}

async function save(gateway: Gateway, head: string, snapshot = edited) {
  return fetch(`${gateway.origin}/api/v1/snapshot`, {
    method: 'PUT', headers, body: JSON.stringify({ expectedHeadSha256: head, snapshot }),
  })
}

describe('Office 持久化条件保存', () => {
  it.each(['write', 'replace'] as const)('%s 失败不推进版本、不改变快照；故障解除后同版本重试成功且重启一致', async (failure) => {
    const { gateway, path, root, options } = await setup()
    const head = gateway.headSha256
    const error = Object.assign(new Error('synthetic disk failure'), { code: 'EACCES' })
    if (failure === 'write') {
      vi.mocked(fs.writeFile).mockImplementationOnce(async (target, ...args) => {
        await originalWrite(target, ...args)
        throw error // partial file exists, and must be removed
      })
    } else vi.mocked(fs.rename).mockRejectedValueOnce(error)

    expect((await save(gateway, head)).status).toBe(500)
    expect(gateway.headSha256).toBe(head)
    const current = await fetch(`${gateway.origin}/api/v1/snapshot`, { headers }).then((r) => r.json())
    expect(current).toEqual({ headSha256: head, snapshot: initial })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(initial)
    expect(await readdir(root)).toEqual(['snapshot.json'])

    const retry = await save(gateway, head)
    expect(retry.status).toBe(200)
    const saved = await retry.json() as { headSha256: string }
    expect(saved.headSha256).toBe(gateway.headSha256)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(edited)
    await gateway.close()
    gateways.splice(gateways.indexOf(gateway), 1)
    const reopened = await startOfficeGatewayV1(options)
    gateways.push(reopened)
    expect(reopened.headSha256).toBe(saved.headSha256)
    expect(await fetch(`${reopened.origin}/api/v1/snapshot`, { headers }).then((r) => r.json()))
      .toEqual({ headSha256: saved.headSha256, snapshot: edited })
  })

  it('落盘期间 GET 保持旧版本，并发同版本保存只有一个成功', async () => {
    const { gateway, path } = await setup()
    const head = gateway.headSha256
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      entered()
      await blocked
      return originalRename(...args)
    })
    const first = save(gateway, head)
    await started
    const second = save(gateway, head, { title: '竞争修改' })
    try {
      expect(await fetch(`${gateway.origin}/api/v1/snapshot`, { headers }).then((r) => r.json()))
        .toEqual({ headSha256: head, snapshot: initial })
    } finally { release() }
    const results = await Promise.all([first, second])
    expect(results.map((r) => r.status)).toEqual([200, 409])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(edited)
    expect((await results[0].json() as { headSha256: string }).headSha256).toBe(gateway.headSha256)
  })
})
