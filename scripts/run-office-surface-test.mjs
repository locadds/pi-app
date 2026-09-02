import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const worktreeRoot = process.env.XIAOGUI_OFFICE_WORKTREE_ROOT
  ?? 'D:\\CodexTemp\\xiaogui-office-surface-worktrees'
const remoteDebuggingPort = process.env.XIAOGUI_OFFICE_REMOTE_DEBUGGING_PORT ?? '9333'
await mkdir(worktreeRoot, { recursive: true })

const cli = resolve(projectRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, 'dev', '--remoteDebuggingPort', remoteDebuggingPort], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    XIAOGUI_OFFICE_TEST: '1',
    XIAOGUI_OFFICE_SURFACE: 'UNIVER_EXPERIMENTAL',
    XIAOGUI_OFFICE_WORKTREE_ROOT: worktreeRoot,
  },
})

child.once('error', (error) => {
  process.stderr.write(`无法启动小规 Office Surface 单机测试版：${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
