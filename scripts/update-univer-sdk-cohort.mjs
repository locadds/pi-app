import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const projectRoot = process.cwd()
const cohort = JSON.parse(readFileSync(resolve(projectRoot, 'univer-sdk-cohort.json'), 'utf8'))
const version = String(cohort.univerSdkVersion)
const packages = [...cohort.packages, ...cohort.proPackages]

if (!/^\d+\.\d+\.\d+$/.test(version) || packages.length === 0) {
  throw new Error('Univer SDK cohort manifest is invalid')
}
if (cohort.proPackages.length > 0 && process.env.XIAOGUI_UNIVER_PRO_LICENSE_APPROVED !== '1') {
  throw new Error('Refusing to add Univer Pro packages without an explicit license approval gate')
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npmCommand, [
  'install',
  '--save-exact',
  '--ignore-scripts',
  ...packages.map((packageName) => `${packageName}@${version}`),
], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
})

process.exit(result.status ?? 1)
