import { describe, expect, it } from 'vitest'

import { normalizePathKey } from './path-key'

describe('normalizePathKey（与渲染层 normalizeSessionFileKey 逐条等价）', () => {
  it('反斜杠归一为正斜杠', () => {
    expect(normalizePathKey('D:\\proj\\a\\.pi\\agent\\sessions\\x.jsonl')).toBe(
      'D:/proj/a/.pi/agent/sessions/x.jsonl',
    )
  })

  it('Windows 盘符统一大写', () => {
    expect(normalizePathKey('d:/proj/s.jsonl')).toBe('D:/proj/s.jsonl')
  })

  it('折叠重复斜杠但保留 UNC 前导 //', () => {
    expect(normalizePathKey('D://proj///a')).toBe('D:/proj/a')
    expect(normalizePathKey('\\\\server\\share\\a')).toBe('//server/share/a')
  })

  it('目录段大小写归一（盘符保持大写）', () => {
    expect(normalizePathKey('D:/Proj/Sub')).toBe('D:/proj/sub')
    expect(normalizePathKey('d:/PROJ/x.jsonl')).toBe('D:/proj/x.jsonl')
    expect(normalizePathKey('\\\\Server\\Share\\A')).toBe('//server/share/a')
    expect(normalizePathKey('D:/proj/sub') === normalizePathKey('d:/PROJ/SUB')).toBe(true)
  })

  it('保留 WSL UNC 中 Linux 路径主体的大小写', () => {
    expect(normalizePathKey('\\\\WSL$\\Debian\\tmp\\CaseRoot\\Session.jsonl')).toBe(
      '//wsl.localhost/debian/tmp/CaseRoot/Session.jsonl',
    )
    expect(normalizePathKey('//wsl.localhost/DEBIAN/tmp/caseroot/session.jsonl')).toBe(
      '//wsl.localhost/debian/tmp/caseroot/session.jsonl',
    )
  })

  it('剥离尾部斜杠（保留盘符根与 UNC 共享根）', () => {
    expect(normalizePathKey('D:/proj/')).toBe('D:/proj')
    expect(normalizePathKey('D:/proj///')).toBe('D:/proj')
    expect(normalizePathKey('d:/')).toBe('D:/')
    expect(normalizePathKey('//server/share/')).toBe('//server/share')
    expect(normalizePathKey('//server/share')).toBe('//server/share')
  })

  it('空值返回空串', () => {
    expect(normalizePathKey('')).toBe('')
    expect(normalizePathKey(null)).toBe('')
    expect(normalizePathKey(undefined)).toBe('')
  })

  it('首尾空白被裁剪', () => {
    expect(normalizePathKey('  d:/a ')).toBe('D:/a')
  })
})
