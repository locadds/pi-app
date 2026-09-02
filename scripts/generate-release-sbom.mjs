#!/usr/bin/env node
/**
 * Generate a minimal CycloneDX-style SBOM from package-lock.
 *
 * Production dependencies and build-time dependencies explicitly bundled into
 * the release are both runtime components and therefore belong in the SBOM.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`INVALID_SBOM_EXTERNAL_RUNTIME:${label}`)
  }
  return value
}

function externalRuntimeComponent(runtime) {
  const name = requireString(runtime?.name, 'name')
  const version = requireString(runtime?.version, `${name}:version`)
  const component = {
    type: requireString(runtime?.type, `${name}:type`),
    name,
    version,
    'bom-ref': requireString(runtime?.bomRef, `${name}:bomRef`),
    hashes: [{ alg: 'SHA-256', content: requireString(runtime?.sha256, `${name}:sha256`) }],
    licenses: [{ license: { id: requireString(runtime?.license, `${name}:license`) } }],
    externalReferences: [
      {
        type: 'distribution',
        url: requireString(runtime?.distributionUrl, `${name}:distributionUrl`),
      },
      { type: 'website', url: requireString(runtime?.sourceUrl, `${name}:sourceUrl`) },
    ],
  }
  return component
}

export async function generateSbom(rootDir = process.cwd(), outputPath = join(rootDir, 'sbom.cdx.json')) {
  const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(rootDir, 'package-lock.json'), 'utf8'))
  const bundledRuntimeNames = Array.isArray(pkg.xiaoguiBuild?.bundledRuntimeDependencies)
    ? pkg.xiaoguiBuild.bundledRuntimeDependencies.filter((name) => typeof name === 'string')
    : []
  const prodNames = new Set([...Object.keys(pkg.dependencies || {}), ...bundledRuntimeNames])
  const components = []
  for (const top of prodNames) {
    const rootEntry = lock.packages?.[`node_modules/${top}`]
    const fallbackEntry = Object.entries(lock.packages || {}).find(([path]) =>
      path.endsWith(`/node_modules/${top}`),
    )?.[1]
    const entry = rootEntry || fallbackEntry
    if (!entry) throw new Error(`SBOM_DEPENDENCY_NOT_LOCKED:${top}`)
    components.push({
      type: 'library',
      name: top,
      version: entry.version || 'unknown',
      'bom-ref': `pkg:npm/${top}@${entry.version || 'unknown'}`,
    })
  }
  const externalRuntimes = Array.isArray(pkg.xiaoguiBuild?.bundledExternalRuntimes)
    ? pkg.xiaoguiBuild.bundledExternalRuntimes
    : []
  components.push(...externalRuntimes.map(externalRuntimeComponent))
  components.sort((a, b) => a.name.localeCompare(b.name))
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: pkg.xiaoguiBuild?.productName || pkg.name,
        version: pkg.version,
      },
    },
    components,
  }
  await writeFile(outputPath, `${JSON.stringify(bom, null, 2)}\n`, 'utf8')
  return { outputPath, componentCount: components.length }
}

const invokedAsCli = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('generate-release-sbom.mjs')
if (invokedAsCli) {
  const out = process.argv[2]
  const root = process.cwd()
  const outputPath = out ? join(root, out) : join(root, 'sbom.cdx.json')
  const r = await generateSbom(root, outputPath)
  console.log(`[release-sbom] wrote ${r.componentCount} components to ${r.outputPath}`)
}
