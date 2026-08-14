import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// probeExtensions 会扫描真实全局目录（~/.pi/agent/extensions 等），
// 测试环境不可控，这里统一替换为受控列表（本测试聚焦 guard-status 自身逻辑）。
const probes = vi.hoisted(() => ({ list: [] as unknown[] }))

vi.mock('../../extension-compat/extension-probe', () => ({
  probeExtensions: () => probes.list,
}))

import { DANGER_CATEGORIES, readGuardStatus, resolveGuardAuditLogPath } from './guard-status'

const GUARD_ENTRY_REL = join('.pi', 'extensions', 'xiaogui-coding-guard', 'index.ts')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'xiaogui-guard-status-'))
  probes.list = []
  delete process.env.XIAOGUI_CODING_AUDIT_LOG
  delete process.env.XIAOGUI_CODING_WRITE_ROOTS
  delete process.env.XIAOGUI_CODING_WORKBENCH
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  delete process.env.XIAOGUI_CODING_AUDIT_LOG
  delete process.env.XIAOGUI_CODING_WRITE_ROOTS
  delete process.env.XIAOGUI_CODING_WORKBENCH
})

describe('guard-status：部署与启用状态', () => {
  it('未部署（临时目录无 .pi/extensions）→ deployed=false, enabled=false', async () => {
    const status = await readGuardStatus(tmp)
    expect(status.version).toBe(1)
    expect(status.deployed).toBe(false)
    expect(status.enabled).toBe(false)
    expect(status.scope).toBeNull()
  })

  it('已部署（存在 xiaogui-coding-guard/index.ts）→ deployed=true', async () => {
    mkdirSync(join(tmp, '.pi', 'extensions', 'xiaogui-coding-guard'), { recursive: true })
    writeFileSync(join(tmp, GUARD_ENTRY_REL), '// xiaogui coding guard entry\n')
    const status = await readGuardStatus(tmp)
    expect(status.deployed).toBe(true)
  })

  it('probe 命中且 enabled && piEnabled → enabled=true 且 scope 取条目 source', async () => {
    probes.list = [
      { name: 'xiaogui-coding-guard', enabled: true, piEnabled: true, source: 'project' },
    ]
    const status = await readGuardStatus(tmp)
    expect(status.enabled).toBe(true)
    expect(status.scope).toBe('project')
  })

  it('probe 命中但 piEnabled=false → enabled=false', async () => {
    probes.list = [
      { name: 'xiaogui-coding-guard', enabled: true, piEnabled: false, source: 'global' },
    ]
    const status = await readGuardStatus(tmp)
    expect(status.enabled).toBe(false)
    expect(status.scope).toBe('global')
  })
})

describe('guard-status：审计路径', () => {
  it('默认路径走 ~/.xiaogui/audit/<sha256(cwd) 前 16 位>.log 公式', async () => {
    const status = await readGuardStatus(tmp)
    expect(status.audit.overrideByEnv).toBe(false)
    expect(status.audit.logPath).toMatch(/[\\/]audit[\\/][0-9a-f]{16}\.log$/)
    expect(status.audit.logPath).toBe(resolveGuardAuditLogPath(tmp).logPath)
    expect(status.audit.exists).toBe(false)
  })

  it('env 覆盖审计路径（XIAOGUI_CODING_AUDIT_LOG）', async () => {
    const overrideLog = join(tmp, 'custom-audit.log')
    process.env.XIAOGUI_CODING_AUDIT_LOG = overrideLog
    const status = await readGuardStatus(tmp)
    expect(status.audit.overrideByEnv).toBe(true)
    expect(status.audit.logPath).toBe(overrideLog)
    expect(status.audit.exists).toBe(false)
  })
})

describe('guard-status：写入根与工作台开关', () => {
  it('writeRoots 首项为 cwd，env 追加项按分隔符拆分', async () => {
    process.env.XIAOGUI_CODING_WRITE_ROOTS =
      join(tmp, 'extra-a') + path.delimiter + join(tmp, 'extra-b')
    const status = await readGuardStatus(tmp)
    expect(status.writeRoots[0]).toBe(tmp)
    expect(status.writeRoots).toContain(join(tmp, 'extra-a'))
    expect(status.writeRoots).toContain(join(tmp, 'extra-b'))
  })

  it('workbenchEnabled 默认 true；XIAOGUI_CODING_WORKBENCH=0 时关闭', async () => {
    expect((await readGuardStatus(tmp)).workbenchEnabled).toBe(true)
    process.env.XIAOGUI_CODING_WORKBENCH = '0'
    expect((await readGuardStatus(tmp)).workbenchEnabled).toBe(false)
  })

  it('危险命令拦截类别固定为 5 类', async () => {
    const status = await readGuardStatus(tmp)
    expect(status.dangerCategories).toEqual(DANGER_CATEGORIES)
    expect(status.dangerCategories.map((c) => c.id)).toEqual([
      'recursive-delete',
      'disk-operation',
      'pipe-execute',
      'irreversible',
      'system-control',
    ])
  })
})
