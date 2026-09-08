import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type * as Pi from '@earendil-works/pi-coding-agent'

type SkillResult = ReturnType<typeof Pi.loadSkills>
type Parser = Pick<typeof Pi, 'parseFrontmatter' | 'createSyntheticSourceInfo'>

/** Repair only files already visited by Pi, without changing signed file bytes. */
export function recoverBomSkills(base: SkillResult, sdk: Parser): SkillResult {
  const skills = [...base.skills]
  const recovered = new Set<string>()
  for (const diagnostic of base.diagnostics) {
    const path = diagnostic.path
    if (!path || diagnostic.type !== 'warning' || diagnostic.message !== 'description is required'
      || skills.some(skill => skill.filePath === path)) continue
    try {
      const raw = readFileSync(path, 'utf8')
      if (!raw.startsWith('\uFEFF')) continue
      const { frontmatter } = sdk.parseFrontmatter<Pi.SkillFrontmatter>(raw.slice(1))
      if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) continue
      const name = frontmatter.name || basename(dirname(path))
      if (typeof name !== 'string' || skills.some(skill => skill.name === name)) continue
      const baseDir = dirname(path)
      skills.push({
        name, description: frontmatter.description, filePath: path, baseDir,
        disableModelInvocation: frontmatter['disable-model-invocation'] === true,
        // Pi DefaultResourceLoader replaces this fallback with its original path metadata.
        sourceInfo: sdk.createSyntheticSourceInfo(path, { source: 'bom-read-compat', scope: 'temporary', baseDir }),
      })
      recovered.add(path)
    } catch { /* Keep Pi's original diagnostic if reading or parsing fails. */ }
  }
  return { skills, diagnostics: base.diagnostics.filter(d => !(d.path && recovered.has(d.path)
    && d.type === 'warning' && d.message === 'description is required')) }
}
