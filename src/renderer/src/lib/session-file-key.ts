/**
 * Normalize sessionFile paths for Map keys / equality.
 * Main process uses path.resolve + drive-letter casing; renderer often sees mixed
 * separators / casing from JSONL list vs worker events — strict === breaks routing.
 *
 * 注意：必须与小规主进程侧 src/main/xiaogui/path-key.ts 的 normalizePathKey
 * 保持逐条等价（大小写归一 / 尾部斜杠剥离规则相同），否则 scope 映射 miss。
 */
export function normalizeSessionFileKey(sessionFile: string | null | undefined): string {
  const raw = String(sessionFile || '').trim()
  if (!raw) return ''
  let key = raw.replace(/\\/g, '/')
  // Collapse duplicate slashes (keep leading // for UNC)
  if (key.startsWith('//')) {
    key = `//${key.slice(2).replace(/\/+/g, '/')}`
  } else {
    key = key.replace(/\/+/g, '/')
  }
  // 目录段大小写归一：Windows 路径大小写不敏感，整体小写避免同目录两种写法
  key = key.toLowerCase()
  // Windows drive letter → uppercase for stable keys
  if (/^[a-z]:\//.test(key)) {
    key = key.charAt(0).toUpperCase() + key.slice(1)
  }
  // 剥离尾部斜杠（保留盘符根 X:/ 与 UNC 共享根 //server/share）
  while (key.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(key) || /^\/\/[^/]+\/[^/]+$/.test(key)) break
    key = key.slice(0, -1)
  }
  return key
}

export function sessionFilesEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ka = normalizeSessionFileKey(a)
  const kb = normalizeSessionFileKey(b)
  if (!ka || !kb) return false
  return ka === kb
}
