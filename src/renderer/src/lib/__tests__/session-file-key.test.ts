import { describe, expect, it } from 'vitest'
import { normalizeSessionFileKey, sessionFilesEqual } from '../session-file-key'

describe('session-file-key', () => {
  it('normalizes windows drive and separators', () => {
    expect(normalizeSessionFileKey('c:\\tmp\\a.jsonl')).toBe('C:/tmp/a.jsonl')
    expect(normalizeSessionFileKey('C:/tmp/a.jsonl')).toBe('C:/tmp/a.jsonl')
    expect(sessionFilesEqual('c:\\tmp\\a.jsonl', 'C:/tmp/a.jsonl')).toBe(true)
  })

  it('collapses duplicate slashes', () => {
    expect(normalizeSessionFileKey('/tmp//a//b.jsonl')).toBe('/tmp/a/b.jsonl')
  })

  it('normalizes directory segment casing (与主进程 normalizePathKey 等价)', () => {
    expect(normalizeSessionFileKey('D:/Proj/Sub\\a.jsonl')).toBe('D:/proj/sub/a.jsonl')
    expect(sessionFilesEqual('d:/PROJ/x.jsonl', 'D:/proj/x.jsonl')).toBe(true)
    expect(normalizeSessionFileKey('\\\\Server\\Share\\a.jsonl')).toBe('//server/share/a.jsonl')
  })

  it('preserves the case-sensitive Linux path body of WSL UNC keys', () => {
    expect(normalizeSessionFileKey('\\\\WSL$\\Debian\\tmp\\CaseRoot\\Session.jsonl')).toBe(
      '//wsl.localhost/debian/tmp/CaseRoot/Session.jsonl',
    )
  })

  it('strips trailing slashes but keeps drive/UNC roots', () => {
    expect(normalizeSessionFileKey('D:/proj/')).toBe('D:/proj')
    expect(normalizeSessionFileKey('D:/proj//')).toBe('D:/proj')
    expect(normalizeSessionFileKey('d:/')).toBe('D:/')
    expect(normalizeSessionFileKey('//server/share/')).toBe('//server/share')
    expect(normalizeSessionFileKey('//server/share')).toBe('//server/share')
  })
})
