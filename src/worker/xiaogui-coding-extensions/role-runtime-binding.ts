import type { CodingRoleAgentSnapshotV1 } from '@shared/xiaogui-coding-role-control'

import { freezeCodingRoleAgentSnapshotV1 } from './role-guard-extension'

/** Worker-memory-only binding. A live session must be explicitly released before reuse. */
export class CodingRoleRuntimeBindingV1 {
  private current: CodingRoleAgentSnapshotV1 | null = null

  assertBindable(value: unknown): CodingRoleAgentSnapshotV1 {
    const incoming = freezeCodingRoleAgentSnapshotV1(value)
    if (!this.current) return incoming
    if (
      this.current.attemptId === incoming.attemptId
      && this.current.snapshotDigest === incoming.snapshotDigest
    ) return this.current
    throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_ALREADY_BOUND')
  }

  bind(value: unknown): CodingRoleAgentSnapshotV1 {
    const incoming = this.assertBindable(value)
    if (!this.current) this.current = incoming
    return this.current
  }

  read(): CodingRoleAgentSnapshotV1 | null {
    return this.current
  }

  activeToolNames(registered: readonly string[]): readonly string[] {
    const unique = [...new Set(registered)]
    // 无角色绑定时透传：绑定只可能存在于 CODING 角色 Attempt 期间
    // （inspectCodingRoleRuntimeV1 非 CODING 直接拒绝），WORK/DESIGN 会话
    // 永远走不到绑定分支；安全由工具、权限、worktree 与交付门强制，
    // 不靠"无绑定即只读"的全局坍缩。
    if (!this.current) return Object.freeze(unique)
    const allowed = new Set(this.current.snapshot.effectiveToolAllowlist)
    return Object.freeze(unique.filter((tool) => allowed.has(tool)))
  }

  release(expectedAttemptId?: string): void {
    if (
      expectedAttemptId !== undefined &&
      this.current &&
      this.current.attemptId !== expectedAttemptId
    ) throw new Error('XIAOGUI_CODING_ROLE_RUNTIME_ATTEMPT_MISMATCH')
    this.current = null
  }
}
