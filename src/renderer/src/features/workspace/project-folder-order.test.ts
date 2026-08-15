import { describe, expect, it } from 'vitest'
import { dedupeByPathKey, projectFolderOrder } from './project-folder-order'

describe('projectFolderOrder', () => {
  it('MRU mode (default): pins the current workspace to the top, then stored order', () => {
    expect(projectFolderOrder(['a', 'b', 'c'], 'b', false)).toEqual(['b', 'a', 'c'])
    expect(projectFolderOrder(['a', 'c'], 'b', false)).toEqual(['b', 'a', 'c'])
    expect(projectFolderOrder([], 'b', false)).toEqual(['b'])
  })

  it('fixed mode: keeps the stored order and never pins the current workspace', () => {
    expect(projectFolderOrder(['a', 'b', 'c'], 'b', true)).toEqual(['a', 'b', 'c'])
    // 当前项目不在列表时追加到末尾（仅保证存在，不置顶）
    expect(projectFolderOrder(['a', 'c'], 'b', true)).toEqual(['a', 'c', 'b'])
    expect(projectFolderOrder([], 'b', true)).toEqual(['b'])
  })

  it('dedupes and ignores falsy entries', () => {
    expect(projectFolderOrder(['a', 'a', 'b'], 'a', false)).toEqual(['a', 'b'])
    expect(projectFolderOrder(['a', 'b'], null, false)).toEqual(['a', 'b'])
    expect(projectFolderOrder(['', 'a'], null, true)).toEqual(['a'])
  })
})

describe('dedupeByPathKey（Windows 盘符/大小写规范化去重）', () => {
  it('同目录仅盘符大小写或写法不同的条目只保留一条（首个出现）', () => {
    expect(dedupeByPathKey(['D:\\proj\\a', 'd:\\proj\\a'], null)).toEqual(['D:\\proj\\a'])
    expect(dedupeByPathKey(['D:/Proj/A', 'd:/proj/a/', 'D:\\other'], null)).toEqual([
      'D:/Proj/A',
      'D:\\other',
    ])
  })

  it('重复条目命中 currentWorkspace 原样写法时替换保留，保住 active 高亮', () => {
    expect(dedupeByPathKey(['D:\\proj\\a', 'd:\\proj\\a'], 'd:\\proj\\a')).toEqual(['d:\\proj\\a'])
    expect(dedupeByPathKey(['D:\\proj\\a', 'd:\\proj\\a'], 'D:\\proj\\a')).toEqual(['D:\\proj\\a'])
  })
})
