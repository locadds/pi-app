import { normalizeSessionFileKey } from '@renderer/lib/session-file-key'

/** 侧栏项目文件夹的显示顺序。 */
export function projectFolderOrder(
  recentProjects: string[],
  currentWorkspace: string | null | undefined,
  fixedOrder: boolean,
): string[] {
  const out: string[] = []
  const add = (p: string) => {
    if (p && !out.includes(p)) out.push(p)
  }
  if (fixedOrder) {
    // 固定顺序：完全按存储顺序展示，当前项目不置顶，仅保证在列表中
    for (const p of recentProjects) add(p)
    if (currentWorkspace) add(currentWorkspace)
  } else {
    // 最近使用（默认）：当前项目置顶，其余按 MRU
    if (currentWorkspace) add(currentWorkspace)
    for (const p of recentProjects) add(p)
  }
  return out
}

/**
 * 按规范化路径 key 去重（Windows 路径大小写不敏感）。
 *
 * 背景：上游 recentProjects 可能同目录存入两种写法（如 `D:\proj` 与
 * `d:\proj`，盘符/大小写漂移），字面 Set/includes 去重失效，侧栏出现
 * 仅 title 盘符大小写不同的重复条目。这里以 normalizeSessionFileKey 生成
 * 的 key 为准去重，保留首次出现的条目（维持 MRU/固定顺序下的原始次序）；
 * 若后出现的重复条目恰为 currentWorkspace 的原样写法，则替换保留它，
 * 保证侧栏 active 高亮（path === currentWorkspace 字面比较）不因去重退化。
 */
export function dedupeByPathKey(
  paths: string[],
  currentWorkspace: string | null | undefined,
): string[] {
  const indexOfKey = new Map<string, number>()
  const out: string[] = []
  for (const p of paths) {
    const key = normalizeSessionFileKey(p)
    if (!key) continue
    const existing = indexOfKey.get(key)
    if (existing !== undefined) {
      if (currentWorkspace && p === currentWorkspace) out[existing] = p
      continue
    }
    indexOfKey.set(key, out.length)
    out.push(p)
  }
  return out
}
