export type OfficeSurfaceErrorCodeV1 =
  | 'OFFICE_SURFACE_DISABLED'
  | 'OFFICE_SURFACE_BAD_MESSAGE'
  | 'OFFICE_SURFACE_ORIGIN_REJECTED'
  | 'OFFICE_GATEWAY_UNAUTHORIZED'
  | 'OFFICE_GATEWAY_BODY_TOO_LARGE'
  | 'OFFICE_WORKTREE_CONFLICT'
  | 'OFFICE_WORKTREE_INVALID_STATE'
  | 'OFFICE_WORKTREE_USER_ACTION_REQUIRED'
  | 'OFFICE_WORKTREE_TRUNK_DIVERGED'
  | 'OFFICE_SNAPSHOT_INVALID'

export class OfficeSurfaceError extends Error {
  readonly code: OfficeSurfaceErrorCodeV1

  constructor(code: OfficeSurfaceErrorCodeV1, message: string) {
    super(message)
    this.name = 'OfficeSurfaceError'
    this.code = code
  }
}
