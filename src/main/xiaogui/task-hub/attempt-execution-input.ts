import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { posix, win32 } from "node:path";

import type {
  AttemptId,
  HubAddressV1,
} from "@shared/xiaogui-collaboration-hub";
import type { PromptEnvelopeRefV1 } from "@shared/xiaogui-agent-runtime";

import type {
  ExecutionWorkspaceBridgeV1,
  RuntimePromptVaultV1,
} from "./application";
import {
  type AttemptFileGrantV1,
  type AttemptWorkspacePortV1,
  type AttemptWorkspacePrepareRequestV1,
} from "./attempt-workspace";
import {
  PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES,
  RUNTIME_PROMPT_MEDIA_TYPE,
  type AttemptBoundPromptEnvelopeRefV1,
  PrivateRuntimePayloadVaultV1,
  digestBytes,
} from "./private-payload-vault";

export type AttemptExecutionInputReasonCodeV1 =
  | "ATTEMPT_INPUT_INVALID"
  | "ATTEMPT_INPUT_MISSING"
  | "ATTEMPT_INPUT_CONFLICT"
  | "ATTEMPT_INPUT_CORRUPT"
  | "ATTEMPT_BINDING_MISMATCH"
  | "BASE_REVISION_UNAVAILABLE"
  | "DELETE_FORBIDDEN";

export class AttemptExecutionInputError extends Error {
  constructor(readonly reasonCode: AttemptExecutionInputReasonCodeV1) {
    super(reasonCode);
    this.name = "AttemptExecutionInputError";
  }
}

export interface StageAttemptExecutionInputV1 {
  readonly attemptId: AttemptId | string;
  readonly projectId: HubAddressV1["projectId"];
  readonly sessionKey: HubAddressV1["sessionKey"];
  readonly promptBytes: Uint8Array | Buffer | string;
  readonly grants: readonly AttemptFileGrantV1[];
}

export interface ResolvedAttemptExecutionInputV1 {
  readonly attemptId: string;
  readonly projectId: HubAddressV1["projectId"];
  readonly sessionKey: HubAddressV1["sessionKey"];
  readonly promptRef: AttemptBoundPromptEnvelopeRefV1;
  readonly grants: readonly AttemptFileGrantV1[];
  readonly inputDigest: string;
}

export interface AttemptExecutionInputOptionsV1 {
  readonly dbPath: string;
  readonly payloadVault: PrivateRuntimePayloadVaultV1;
  readonly workspace: AttemptWorkspacePortV1;
  readonly ownerId?: string;
  readonly now?: () => string;
}

interface AttemptExecutionInputRowV1 {
  attempt_id: string;
  project_id: string;
  session_key: string;
  input_digest: string;
  prompt_ref_json: string;
  grants_json: string;
}

/**
 * Main-process-only seam joining private prompt/file inputs to the public M2B
 * workspace lifecycle. Prompt bytes and file paths never enter hub DTOs.
 * The injected payload vault remains owned by the caller and must be closed by it.
 */
export class AttemptExecutionInputStoreV1 implements RuntimePromptVaultV1 {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly ownerId: string;

  readonly bridge: ExecutionWorkspaceBridgeV1;

  constructor(private readonly options: AttemptExecutionInputOptionsV1) {
    this.db = new DatabaseSync(options.dbPath);
    this.now = options.now ?? (() => new Date().toISOString());
    this.ownerId = cleanOwnerId(options.ownerId ?? "xiaogui-main-process");
    this.db.exec("pragma foreign_keys = on");
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma busy_timeout = 5000");
    this.migrate();
    this.bridge = {
      prepare: (input) => this.prepareWorkspace(input),
      runtimeWorkspace: (attemptId) =>
        this.options.workspace.runtimeBinding(attemptId),
    };
  }

  stage(input: StageAttemptExecutionInputV1): ResolvedAttemptExecutionInputV1 {
    const attemptId = cleanAttemptId(input.attemptId);
    const projectId = cleanProjectId(input.projectId);
    const sessionKey = cleanSessionKey(input.sessionKey);
    const promptBytes = asPromptBytes(input.promptBytes);
    const grants = canonicalGrants(input.grants);
    const candidate = candidateInput(
      attemptId,
      projectId,
      sessionKey,
      promptBytes,
      grants,
    );
    const existing = this.row(attemptId);
    if (existing) return assertReplay(this.resolveRow(existing), candidate);

    const promptRef = this.options.payloadVault.putPrompt({
      attemptId,
      payloadBytes: promptBytes,
      refId: candidate.promptRef.refId,
    });
    if (!samePromptRef(promptRef, candidate.promptRef))
      throw new AttemptExecutionInputError("ATTEMPT_INPUT_CORRUPT");

    this.db.exec("begin immediate");
    try {
      const raced = this.row(attemptId);
      if (raced) {
        this.db.exec("commit");
        return assertReplay(this.resolveRow(raced), candidate);
      }
      this.db
        .prepare(
          "insert into attempt_execution_inputs (attempt_id, project_id, session_key, input_digest, prompt_ref_json, grants_json, created_at) values (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          attemptId,
          projectId,
          sessionKey,
          candidate.inputDigest,
          JSON.stringify(promptRef),
          JSON.stringify(grants),
          this.now(),
        );
      this.db.exec("commit");
    } catch (error) {
      rollbackQuietly(this.db);
      throw error;
    }
    return this.resolve(attemptId);
  }

  resolve(attemptId: AttemptId | string): ResolvedAttemptExecutionInputV1 {
    const cleanId = cleanAttemptId(attemptId);
    const row = this.row(cleanId);
    if (!row) throw new AttemptExecutionInputError("ATTEMPT_INPUT_MISSING");
    return this.resolveRow(row);
  }

  promptRefForAttempt(attemptId: string): PromptEnvelopeRefV1 {
    return this.resolve(attemptId).promptRef;
  }

  close(): void {
    this.db.close();
  }

  private async prepareWorkspace(
    input: Parameters<ExecutionWorkspaceBridgeV1["prepare"]>[0],
  ): Promise<Awaited<ReturnType<ExecutionWorkspaceBridgeV1["prepare"]>>> {
    const attemptId = cleanAttemptId(input.attempt.attempt_id);
    if (
      input.composition.attemptId !== attemptId ||
      input.attempt.flow_id !== input.baseline.flow_id ||
      input.composition.baselineBindingDigest !==
        input.baseline.baseline_binding_digest
    ) {
      throw new AttemptExecutionInputError("ATTEMPT_BINDING_MISMATCH");
    }
    const staged = this.resolve(attemptId);
    if (
      staged.projectId !== input.address.projectId ||
      staged.sessionKey !== input.address.sessionKey
    ) {
      throw new AttemptExecutionInputError("ATTEMPT_BINDING_MISMATCH");
    }
    const baseRevision = cleanBaseRevision(input.baseline.base_revision);
    const request: AttemptWorkspacePrepareRequestV1 = {
      attemptId,
      compositionAttemptId: input.composition.compositionAttemptId,
      requestDigest: input.composition.requestDigest,
      baselineBindingDigest: input.composition.baselineBindingDigest,
      compositionDigest: input.composition.compositionDigest,
      projectId: input.address.projectId,
      baseRevision,
      baselineTreeHash: input.baseline.baseline_tree_hash,
      manifest: { attemptId, version: 1, grants: staged.grants },
      ownerId: this.ownerId,
    };
    return (await this.options.workspace.prepare(request)).receipt;
  }

  private resolveRow(
    row: AttemptExecutionInputRowV1,
  ): ResolvedAttemptExecutionInputV1 {
    try {
      const attemptId = cleanAttemptId(row.attempt_id);
      const projectId = cleanProjectId(row.project_id);
      const sessionKey = cleanSessionKey(row.session_key);
      const promptRef = parsePromptRef(row.prompt_ref_json, attemptId);
      const grants = parseCanonicalGrants(row.grants_json);
      const inputDigest = digestInput(
        attemptId,
        projectId,
        sessionKey,
        promptRef,
        grants,
      );
      if (row.input_digest !== inputDigest)
        throw new AttemptExecutionInputError("ATTEMPT_INPUT_CORRUPT");
      const actualPromptRef =
        this.options.payloadVault.promptRefForAttempt(attemptId);
      if (!samePromptRef(actualPromptRef, promptRef))
        throw new AttemptExecutionInputError("ATTEMPT_INPUT_CORRUPT");
      return {
        attemptId,
        projectId,
        sessionKey,
        promptRef,
        grants,
        inputDigest,
      };
    } catch (error) {
      if (
        error instanceof AttemptExecutionInputError &&
        error.reasonCode === "ATTEMPT_INPUT_CORRUPT"
      )
        throw error;
      throw new AttemptExecutionInputError("ATTEMPT_INPUT_CORRUPT");
    }
  }

  private row(attemptId: string): AttemptExecutionInputRowV1 | undefined {
    return this.db
      .prepare(
        "select attempt_id, project_id, session_key, input_digest, prompt_ref_json, grants_json from attempt_execution_inputs where attempt_id = ?",
      )
      .get(attemptId) as AttemptExecutionInputRowV1 | undefined;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists attempt_execution_inputs (
        attempt_id text primary key,
        project_id text not null,
        session_key text not null,
        input_digest text not null,
        prompt_ref_json text not null,
        grants_json text not null,
        created_at text not null
      );
    `);
    const columns = new Set(
      (
        this.db
          .prepare(
            "select name from pragma_table_info('attempt_execution_inputs')",
          )
          .all() as Array<{ name: string }>
      ).map(({ name }) => name),
    );
    if (!columns.has("project_id"))
      this.db.exec(
        "alter table attempt_execution_inputs add column project_id text",
      );
    if (!columns.has("session_key"))
      this.db.exec(
        "alter table attempt_execution_inputs add column session_key text",
      );
  }
}

function candidateInput(
  attemptId: string,
  projectId: HubAddressV1["projectId"],
  sessionKey: HubAddressV1["sessionKey"],
  promptBytes: Buffer,
  grants: readonly AttemptFileGrantV1[],
): ResolvedAttemptExecutionInputV1 {
  const promptRef: AttemptBoundPromptEnvelopeRefV1 = {
    refId: fixedPromptRefId(attemptId),
    digest: digestBytes(promptBytes),
    mediaType: RUNTIME_PROMPT_MEDIA_TYPE,
    attemptId,
  };
  return {
    attemptId,
    projectId,
    sessionKey,
    promptRef,
    grants,
    inputDigest: digestInput(
      attemptId,
      projectId,
      sessionKey,
      promptRef,
      grants,
    ),
  };
}

function assertReplay(
  existing: ResolvedAttemptExecutionInputV1,
  candidate: ResolvedAttemptExecutionInputV1,
): ResolvedAttemptExecutionInputV1 {
  if (
    existing.inputDigest !== candidate.inputDigest ||
    existing.projectId !== candidate.projectId ||
    existing.sessionKey !== candidate.sessionKey ||
    !samePromptRef(existing.promptRef, candidate.promptRef) ||
    JSON.stringify(existing.grants) !== JSON.stringify(candidate.grants)
  ) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_CONFLICT");
  }
  return existing;
}

function parsePromptRef(
  value: string,
  attemptId: string,
): AttemptBoundPromptEnvelopeRefV1 {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (
    !isExactKeySet(parsed, ["refId", "digest", "mediaType", "attemptId"]) ||
    parsed.refId !== fixedPromptRefId(attemptId) ||
    !cleanDigest(parsed.digest) ||
    parsed.mediaType !== RUNTIME_PROMPT_MEDIA_TYPE ||
    parsed.attemptId !== attemptId
  ) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_CORRUPT");
  }
  return {
    refId: parsed.refId,
    digest: parsed.digest,
    mediaType: RUNTIME_PROMPT_MEDIA_TYPE,
    attemptId,
  } as AttemptBoundPromptEnvelopeRefV1;
}

function parseCanonicalGrants(value: string): readonly AttemptFileGrantV1[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed))
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_CORRUPT");
  const grants = canonicalGrants(parsed as readonly AttemptFileGrantV1[]);
  if (JSON.stringify(grants) !== value)
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_CORRUPT");
  return grants;
}

function canonicalGrants(
  grants: readonly AttemptFileGrantV1[],
): readonly AttemptFileGrantV1[] {
  if (!Array.isArray(grants) || grants.length === 0)
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  const seen = new Set<string>();
  const result = grants.map((grant) => {
    if (!grant || typeof grant !== "object")
      throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
    if (grant.operation === "DELETE")
      throw new AttemptExecutionInputError("DELETE_FORBIDDEN");
    if (grant.operation !== "CREATE" && grant.operation !== "MODIFY") {
      throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
    }
    const relativePath = cleanRelativePath(grant.relativePath);
    const pathKey = relativePath.toLowerCase();
    if (seen.has(pathKey))
      throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
    seen.add(pathKey);
    if (grant.operation === "CREATE") {
      if (
        !isExactKeySet(grant as unknown as Record<string, unknown>, [
          "operation",
          "relativePath",
        ])
      ) {
        throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
      }
      return { operation: "CREATE" as const, relativePath };
    }
    if (
      !isExactKeySet(grant as unknown as Record<string, unknown>, [
        "operation",
        "relativePath",
        "baselineDigest",
      ]) ||
      !cleanDigest(grant.baselineDigest)
    ) {
      throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
    }
    return {
      operation: "MODIFY" as const,
      relativePath,
      baselineDigest: grant.baselineDigest,
    };
  });
  return result.sort(
    (left, right) =>
      left.relativePath.localeCompare(right.relativePath) ||
      left.operation.localeCompare(right.operation),
  );
}

function cleanRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes(":") ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("//")
  ) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  }
  const normalized = value.replace(/[\\]+/g, "/");
  const parts = normalized.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git",
    )
  ) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  }
  return posix.normalize(normalized);
}

function cleanAttemptId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim()
  ) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  }
  return value;
}

function cleanProjectId(value: unknown): HubAddressV1["projectId"] {
  if (typeof value !== "string" || !/^xgp1_[0-9a-f]{64}$/.test(value)) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  }
  return value as HubAddressV1["projectId"];
}

function cleanSessionKey(value: unknown): HubAddressV1["sessionKey"] {
  if (typeof value !== "string" || !/^xgs1_[0-9a-f]{64}$/.test(value)) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  }
  return value as HubAddressV1["sessionKey"];
}

function cleanOwnerId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value !== value.trim()
  ) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  }
  return value;
}

function cleanBaseRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new AttemptExecutionInputError("BASE_REVISION_UNAVAILABLE");
  }
  return value;
}

function cleanDigest(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function asPromptBytes(value: Uint8Array | Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from(value);
  if (bytes.length === 0 || bytes.length > PRIVATE_RUNTIME_PAYLOAD_MAX_BYTES) {
    throw new AttemptExecutionInputError("ATTEMPT_INPUT_INVALID");
  }
  return bytes;
}

function fixedPromptRefId(attemptId: string): string {
  return `xhbaip_${hashHex(`attempt-prompt:${attemptId}`).slice(0, 48)}`;
}

function digestInput(
  attemptId: string,
  projectId: HubAddressV1["projectId"],
  sessionKey: HubAddressV1["sessionKey"],
  promptRef: AttemptBoundPromptEnvelopeRefV1,
  grants: readonly AttemptFileGrantV1[],
): string {
  return `sha256:${hashHex(JSON.stringify({ attemptId, projectId, sessionKey, promptRef, grants }))}`;
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePromptRef(
  left: PromptEnvelopeRefV1,
  right: PromptEnvelopeRefV1,
): boolean {
  const leftAttemptId = (left as { attemptId?: unknown }).attemptId;
  const rightAttemptId = (right as { attemptId?: unknown }).attemptId;
  return (
    left.refId === right.refId &&
    left.digest === right.digest &&
    left.mediaType === right.mediaType &&
    leftAttemptId === rightAttemptId
  );
}

function isExactKeySet(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("rollback");
  } catch {
    // No active transaction or rollback failed; preserve the original error.
  }
}
