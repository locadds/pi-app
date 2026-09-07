import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@earendil-works/pi-coding-agent'
import { recoverBomSkills } from '../src/worker/skill-bom-compat.ts'
import { canonicalSkillPath, filterSkillsByEnabledPaths } from '../packages/shared/skill-catalog.ts'

const root = mkdtempSync(join(tmpdir(), 'c2-sdk-bom-'))
const cwd = join(root, 'workspace')
const agentDir = join(root, 'agent')
const directory = join(agentDir, 'skills', '7cb95dd2-35fc-4e10-989f-9ec9b1f88ab6')
const path = join(directory, 'SKILL.md')
const content = '---\nname: c2-lan-acceptance\ndescription: 实际SDK发现检查\ndisable-model-invocation: true\n---\n正文'
const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex')
try {
  mkdirSync(cwd, { recursive: true }); mkdirSync(directory, { recursive: true })
  let expectedSource: unknown
  for (const bom of ['', '\uFEFF']) {
    writeFileSync(path, bom + content, 'utf8')
    const before = hash()
    const native = sdk.loadSkillsFromDir({ dir: directory, source: 'user' })
    assert.equal(native.skills.length, bom ? 0 : 1)
    let adapterCalls = 0
    const loader = new sdk.DefaultResourceLoader({
      cwd, agentDir, settingsManager: sdk.SettingsManager.inMemory(),
      noExtensions: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      skillsOverride: base => { adapterCalls++; return recoverBomSkills(base, sdk) },
    })
    await loader.reload()
    const result = loader.getSkills()
    const ownSkills = result.skills.filter(skill => skill.filePath === path)
    assert.equal(ownSkills.length, 1)
    const skill = ownSkills[0]!
    assert.equal(skill.name, 'c2-lan-acceptance')
    assert.equal(skill.description, '实际SDK发现检查')
    assert.equal(skill.filePath, path)
    assert.equal(skill.baseDir, directory)
    assert.equal(skill.disableModelInvocation, true)
    assert.equal(skill.sourceInfo.scope, 'user')
    assert.notEqual(skill.sourceInfo.source, 'bom-read-compat')
    if (!bom) expectedSource = skill.sourceInfo
    else assert.deepEqual(skill.sourceInfo, expectedSource)
    await loader.reload()
    assert.ok(adapterCalls >= 2)
    assert.equal(loader.getSkills().skills.filter(skill => skill.filePath === path).length, 1)
    assert.equal(filterSkillsByEnabledPaths(ownSkills, { [`path:${canonicalSkillPath(path)}`]: false }).length, 0)
    assert.equal(hash(), before)
  }
  for (const invalid of ['\uFEFF---\nname: missing\n---\n正文', '\uFEFF\uFEFF' + content]) {
    writeFileSync(path, invalid, 'utf8')
    const before = hash()
    const result = recoverBomSkills(sdk.loadSkillsFromDir({ dir: directory, source: 'user' }), sdk)
    assert.equal(result.skills.length, 0)
    assert.ok(result.diagnostics.some(d => d.message === 'description is required'))
    assert.equal(hash(), before)
  }
  console.log('PASS: real Pi discovery -> existing override hook -> getSkills; BOM/non-BOM metadata and source identical; refresh stable; missing description rejected; file bytes unchanged; no model/session')
} finally { rmSync(root, { recursive: true, force: true }) }
