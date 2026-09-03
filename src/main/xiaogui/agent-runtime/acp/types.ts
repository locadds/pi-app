export interface AcpInitializeParamsV1 {
  protocolVersion: number
  clientCapabilities: {
    fs: { readTextFile: true; writeTextFile: boolean }
    terminal: boolean
    elicitation?: { form: Readonly<Record<string, never>> }
  }
  clientInfo: { name: string; version: string }
}

export interface AcpInitializeResultV1 {
  protocolVersion: number
  agentInfo?: { name?: string; version?: string }
  agentCapabilities?: { loadSession?: boolean; [key: string]: unknown }
}

export interface AcpContentBlockV1 {
  type: 'text' | string
  text?: string
  [key: string]: unknown
}

export interface AcpSessionUpdateParamsV1 {
  sessionId: string
  update: {
    sessionUpdate?: string
    content?: AcpContentBlockV1 | unknown[]
    toolCallId?: string
    title?: string
    kind?: string
    status?: string
    locations?: Array<{ path: string; line?: number }>
    rawInput?: unknown
    [key: string]: unknown
  }
}

export interface AcpPermissionOptionV1 {
  optionId: string
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export interface AcpRequestPermissionParamsV1 {
  sessionId: string
  toolCall?: {
    toolCallId?: string
    title?: string
    kind?: string
    status?: string
    locations?: Array<{ path: string; line?: number }>
    content?: unknown[]
    rawInput?: unknown
    [key: string]: unknown
  }
  options?: AcpPermissionOptionV1[]
}

export interface AcpRequestPermissionResultV1 {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
}

export interface AcpElicitationCreateParamsV1 {
  mode?: string
  sessionId?: string
  message?: string
  requestedSchema?: unknown
}

export type AcpElicitationCreateResultV1 =
  | { action: 'accept'; content: { value: string } }
  | { action: 'cancel' }

export type AcpClientRequestHandlerV1 = (params: unknown) => Promise<unknown> | unknown

export interface AcpTransportStartOptionsV1 {
  cwd: string
  initialize: AcpInitializeParamsV1
  requestHandlers: ReadonlyMap<string, AcpClientRequestHandlerV1>
  onSessionUpdate: (params: AcpSessionUpdateParamsV1) => void
  onPermissionRequest: (params: AcpRequestPermissionParamsV1) => Promise<AcpRequestPermissionResultV1>
  onDisconnect: (reasonCode: string) => void
}

export interface AcpTransportV1 {
  start(options: AcpTransportStartOptionsV1): Promise<AcpInitializeResultV1>
  newSession(cwd: string): Promise<{ sessionId: string }>
  loadSession(sessionId: string, cwd: string): Promise<void>
  /** Optional native ACP configuration seam. Runtimes that need a frozen selector require it explicitly. */
  setConfigOption?(sessionId: string, configId: string, value: string): Promise<void>
  prompt(sessionId: string, prompt: AcpContentBlockV1[]): Promise<{ stopReason?: string }>
  cancel(sessionId: string): Promise<void> | void
  dispose(): Promise<void> | void
}

export interface AcpTransportFactoryV1 {
  create(command: string, args: readonly string[], cwd: string, options?: AcpTransportCreateOptionsV1): AcpTransportV1
}

export interface AcpTransportCreateOptionsV1 {
  env?: Readonly<Record<string, string>>
  /** Defaults to true for existing runtimes; trusted runtimes can supply a closed environment. */
  inheritParentEnvironment?: boolean
  preSpawn?: () => void | Promise<void>
}
