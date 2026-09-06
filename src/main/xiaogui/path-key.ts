/**
 * 主进程侧路径规范化（小规 scope 映射 key 用）。
 *
 * 必须与渲染进程 src/renderer/src/lib/session-file-key.ts 的
 * normalizeSessionFileKey 保持逐条等价（Windows/WSL 下大小写与斜杠差异
 * 会导致映射 miss → 静默降级 WORK）：反斜杠归一为正斜杠、折叠重复斜杠
 * （保留 UNC 前导 //）、本机 Windows 路径大小写归一；WSL UNC 仅归一
 * server/distribution，保留 Linux 路径主体大小写）、剥离尾部斜杠（保留盘符根 X:/ 与 UNC 共享
 * 根 //server/share）。两份实现分属不同构建目标（node/web），无法共享源码，
 * 修改任一侧时务必同步另一侧。
 */
export function normalizePathKey(path: string | null | undefined): string {
  const raw = String(path || '').trim()
  if (!raw) return ''
  let key = raw.replace(/\\/g, '/')
  // Collapse duplicate slashes (keep leading // for UNC)
  if (key.startsWith('//')) {
    key = `//${key.slice(2).replace(/\/+/g, '/')}`
  } else {
    key = key.replace(/\/+/g, '/')
  }
  const wslMatch = /^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(.*)$/i.exec(key)
  if (wslMatch) {
    // Server and distro are Windows-side identifiers. The remaining path is
    // handled by Linux and must retain its case-sensitive spelling.
    key = `//wsl.localhost/${wslMatch[2].toLowerCase()}${wslMatch[3]}`
  } else {
    key = key.toLowerCase()
  }
  // Windows drive letter -> uppercase for stable keys
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
