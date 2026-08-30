import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startOfficeGatewayV1 } from './server'

const COOKIE = 'xiaogui_office_test'
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'

describe('Office Gateway V1', () => {
  it('keeps snapshots behind a session cookie and rejects stale writes', async () => {
    const gateway = await startOfficeGatewayV1({
      sessionCookieName: COOKIE,
      sessionToken: TOKEN,
      initialSnapshot: { id: 'synthetic-document', title: '小规文档界面验证' },
      viewerFallbackHtml: '<!doctype html><title>小规文档界面</title>',
    })
    const headers = { Cookie: `${COOKIE}=${TOKEN}` }
    try {
      expect((await fetch(`${gateway.origin}/health`)).status).toBe(200)
      expect((await fetch(`${gateway.origin}/api/v1/snapshot`)).status).toBe(401)
      expect((await fetch(`${gateway.origin}/api/v1/snapshot`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })).status).toBe(401)

      const beforeResponse = await fetch(`${gateway.origin}/api/v1/snapshot`, { headers })
      const before = await beforeResponse.json() as { headSha256: string; snapshot: Record<string, unknown> }
      expect(before.snapshot.title).toBe('小规文档界面验证')

      const saveResponse = await fetch(`${gateway.origin}/api/v1/snapshot`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedHeadSha256: before.headSha256,
          snapshot: { id: 'synthetic-document', title: '已保存的新版本' },
        }),
      })
      expect(saveResponse.status).toBe(200)

      const conflict = await fetch(`${gateway.origin}/api/v1/snapshot`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedHeadSha256: before.headSha256, snapshot: { title: '过期写入' } }),
      })
      expect(conflict.status).toBe(409)
      expect((await conflict.json() as { error: string }).error).toBe('OFFICE_WORKTREE_CONFLICT')

      const viewer = await fetch(`${gateway.origin}/viewer/`, { headers })
      expect(await viewer.text()).toContain('小规文档界面')
    } finally {
      await gateway.close()
    }
  })

  it('restores the private worktree after the gateway restarts', async () => {
    const evidenceRoot = 'D:\\CodexTemp'
    await mkdir(evidenceRoot, { recursive: true })
    const temporaryRoot = await mkdtemp(join(evidenceRoot, 'xiaogui-office-gateway-'))
    const persistencePath = join(temporaryRoot, 'worktree.json')
    const headers = { Cookie: `${COOKIE}=${TOKEN}` }
    let firstGateway: Awaited<ReturnType<typeof startOfficeGatewayV1>> | null = null
    let secondGateway: Awaited<ReturnType<typeof startOfficeGatewayV1>> | null = null
    try {
      firstGateway = await startOfficeGatewayV1({
        sessionCookieName: COOKIE,
        sessionToken: TOKEN,
        initialSnapshot: { title: '初始工作副本' },
        snapshotPersistencePath: persistencePath,
      })
      const before = await fetch(`${firstGateway.origin}/api/v1/snapshot`, { headers })
        .then((response) => response.json()) as { headSha256: string }
      const saved = await fetch(`${firstGateway.origin}/api/v1/snapshot`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedHeadSha256: before.headSha256,
          snapshot: { title: '重启后应恢复的工作副本', fields: ['项目名称'] },
        }),
      })
      expect(saved.status).toBe(200)
      await firstGateway.close()
      firstGateway = null

      secondGateway = await startOfficeGatewayV1({
        sessionCookieName: COOKIE,
        sessionToken: TOKEN,
        initialSnapshot: { title: '不应覆盖已保存工作副本' },
        snapshotPersistencePath: persistencePath,
      })
      const restored = await fetch(`${secondGateway.origin}/api/v1/snapshot`, { headers })
        .then((response) => response.json()) as { snapshot: Record<string, unknown> }
      expect(restored.snapshot).toEqual({
        title: '重启后应恢复的工作副本',
        fields: ['项目名称'],
      })
    } finally {
      await firstGateway?.close().catch(() => {})
      await secondGateway?.close().catch(() => {})
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('fails explicitly when the persisted worktree is corrupt', async () => {
    const evidenceRoot = 'D:\\CodexTemp'
    await mkdir(evidenceRoot, { recursive: true })
    const temporaryRoot = await mkdtemp(join(evidenceRoot, 'xiaogui-office-gateway-corrupt-'))
    const persistencePath = join(temporaryRoot, 'worktree.json')
    try {
      await writeFile(persistencePath, '{not-json', 'utf8')
      await expect(startOfficeGatewayV1({
        sessionCookieName: COOKIE,
        sessionToken: TOKEN,
        initialSnapshot: { title: '不得静默覆盖损坏快照' },
        snapshotPersistencePath: persistencePath,
      })).rejects.toThrow('OFFICE_WORKTREE_SNAPSHOT_CORRUPT')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
