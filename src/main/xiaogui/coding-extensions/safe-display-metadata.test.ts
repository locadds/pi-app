import { describe, expect, it } from 'vitest'
import { safeCodingPermissionDisplayMetadata } from './safe-display-metadata'

describe('safeCodingPermissionDisplayMetadata', () => {
  it.each([
    'run(C:/Users/alice/key.txt)',
    'run(\\\\server\\share\\key.txt)',
    'file:///C:/Users/alice/key.txt',
    'read /home/alice/key.txt',
    'run(/secret)',
    'cat /data',
    'echo>/secret',
    'cat;/data',
    'cmd|/home/alice/key',
    'copy&/tmp/key',
    'Authorization: Bearer abc123',
    'token abc123',
    'Bearer sk-secretvalue',
    'https://alice:secret@example.test',
    'npm run\ntypecheck',
  ])('拒绝可能泄露路径、凭据或控制字符的展示摘要：%s', (value) => {
    expect(safeCodingPermissionDisplayMetadata(value)).toBeUndefined()
  })

  it('保留简短、无敏感信息的命令和外传目的摘要', () => {
    expect(safeCodingPermissionDisplayMetadata('  npm run typecheck  ')).toBe('npm run typecheck')
    expect(safeCodingPermissionDisplayMetadata('approved.example.test')).toBe('approved.example.test')
  })
})
