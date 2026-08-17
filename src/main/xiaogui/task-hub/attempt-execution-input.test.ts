import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type {
  AttemptId,
  HubAddressV1,
  WorkspacePreparedReceiptM2BV1,
} from "@shared/xiaogui-collaboration-hub";
import type { RuntimeWorkspaceBindingV1 } from "@shared/xiaogui-agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExecutionWorkspaceBridgeV1 } from "./application";
import type {
  AttemptWorkspacePortV1,
  AttemptWorkspacePrepareRequestV1,
} from "./attempt-workspace";
import { AttemptExecutionInputStoreV1 } from "./attempt-execution-input";
import {
  PrivateRuntimePayloadVaultV1,
  digestBytes,
} from "./private-payload-vault";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("AttemptExecutionInputStoreV1", () => {
  it("stages one canonical input idempotently and rejects prompt, grant, or DELETE drift", () => {
    const fixture = createFixture();
    try {
      const first = fixture.store.stage({
        attemptId: ATTEMPT_ID,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        promptBytes: "implement the approved slice",
        grants: [
          { operation: "CREATE", relativePath: "src/created.ts" },
          {
            operation: "MODIFY",
            relativePath: "src/existing.ts",
            baselineDigest: digestBytes("before"),
          },
        ],
      });
      const replay = fixture.store.stage({
        attemptId: ATTEMPT_ID,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        promptBytes: "implement the approved slice",
        grants: [
          {
            operation: "MODIFY",
            relativePath: "src/existing.ts",
            baselineDigest: digestBytes("before"),
          },
          { operation: "CREATE", relativePath: "src/created.ts" },
        ],
      });

      expect(replay).toEqual(first);
      expect(first).toMatchObject(ADDRESS);
      expect(first.promptRef.refId).toMatch(/^xhbaip_[a-f0-9]{48}$/);
      expect(() =>
        fixture.store.stage({
          attemptId: ATTEMPT_ID,
          projectId: ADDRESS.projectId,
          sessionKey: ADDRESS.sessionKey,
          promptBytes: "different prompt",
          grants: first.grants,
        }),
      ).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_CONFLICT" }),
      );
      expect(() =>
        fixture.store.stage({
          attemptId: ATTEMPT_ID,
          projectId: ADDRESS.projectId,
          sessionKey: ADDRESS.sessionKey,
          promptBytes: "implement the approved slice",
          grants: [{ operation: "CREATE", relativePath: "src/different.ts" }],
        }),
      ).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_CONFLICT" }),
      );
      expect(() =>
        fixture.store.stage({
          attemptId: ATTEMPT_ID,
          projectId: OTHER_PROJECT_ID,
          sessionKey: ADDRESS.sessionKey,
          promptBytes: "implement the approved slice",
          grants: first.grants,
        }),
      ).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_CONFLICT" }),
      );
      expect(() =>
        fixture.store.stage({
          attemptId: ATTEMPT_ID,
          projectId: ADDRESS.projectId,
          sessionKey: OTHER_SESSION_KEY,
          promptBytes: "implement the approved slice",
          grants: first.grants,
        }),
      ).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_CONFLICT" }),
      );
      expect(() =>
        fixture.store.stage({
          attemptId: "xhba_delete",
          projectId: ADDRESS.projectId,
          sessionKey: ADDRESS.sessionKey,
          promptBytes: "delete",
          grants: [{ operation: "DELETE", relativePath: "src/existing.ts" }],
        }),
      ).toThrow(expect.objectContaining({ reasonCode: "DELETE_FORBIDDEN" }));
      expect(() =>
        fixture.store.stage({
          attemptId: "xhba_empty",
          projectId: ADDRESS.projectId,
          sessionKey: ADDRESS.sessionKey,
          promptBytes: "no files",
          grants: [],
        }),
      ).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_INVALID" }),
      );
    } finally {
      fixture.close();
    }
  });

  it("fails closed for a missing row, row corruption, or a missing private prompt", () => {
    const fixture = createFixture();
    try {
      expect(() => fixture.store.resolve(ATTEMPT_ID)).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_MISSING" }),
      );
      fixture.store.stage({
        attemptId: ATTEMPT_ID,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        promptBytes: "private prompt",
        grants: [{ operation: "CREATE", relativePath: "src/new.ts" }],
      });
      mutateDb(fixture.inputDbPath, (db) => {
        db.prepare(
          "update attempt_execution_inputs set grants_json = ? where attempt_id = ?",
        ).run("[]", ATTEMPT_ID);
      });
      expect(() => fixture.store.resolve(ATTEMPT_ID)).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_CORRUPT" }),
      );

      fixture.store.stage({
        attemptId: OTHER_ATTEMPT_ID,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        promptBytes: "another private prompt",
        grants: [{ operation: "CREATE", relativePath: "src/other.ts" }],
      });
      mutateDb(fixture.payloadDbPath, (db) => {
        db.prepare(
          "delete from private_runtime_payloads where attempt_id = ?",
        ).run(OTHER_ATTEMPT_ID);
      });
      expect(() => fixture.store.resolve(OTHER_ATTEMPT_ID)).toThrow(
        expect.objectContaining({ reasonCode: "ATTEMPT_INPUT_CORRUPT" }),
      );
    } finally {
      fixture.close();
    }
  });

  it("maps the staged input exactly into workspace.prepare and rejects missing input or base revision first", async () => {
    const receipt = preparedReceipt();
    const runtimeWorkspace = workspaceBinding();
    const prepare = vi.fn(
      async (_request: AttemptWorkspacePrepareRequestV1) => ({ receipt }),
    );
    const runtimeBinding = vi.fn(
      async (_attemptId: string) => runtimeWorkspace,
    );
    const fixture = createFixture({ prepare, runtimeBinding });
    try {
      const staged = fixture.store.stage({
        attemptId: ATTEMPT_ID,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        promptBytes: "private coding instruction",
        grants: [
          {
            operation: "MODIFY",
            relativePath: "src/existing.ts",
            baselineDigest: digestBytes("before"),
          },
        ],
      });
      const bridgeInput = workspaceBridgeInput(ATTEMPT_ID, BASE_REVISION);

      await expect(fixture.store.bridge.prepare(bridgeInput)).resolves.toEqual(
        receipt,
      );
      expect(prepare).toHaveBeenCalledWith({
        attemptId: ATTEMPT_ID,
        compositionAttemptId: "xhbca_1",
        requestDigest: "sha256:request",
        baselineBindingDigest: "sha256:baseline-binding",
        compositionDigest: "sha256:composition",
        projectId: ADDRESS.projectId,
        baseRevision: BASE_REVISION,
        baselineTreeHash: "sha256:tree",
        manifest: { attemptId: ATTEMPT_ID, version: 1, grants: staged.grants },
        ownerId: "xiaogui-main-process",
      });
      await expect(
        fixture.store.bridge.runtimeWorkspace(ATTEMPT_ID),
      ).resolves.toEqual(runtimeWorkspace);
      expect(runtimeBinding).toHaveBeenCalledWith(ATTEMPT_ID);
      expect(fixture.store.promptRefForAttempt(ATTEMPT_ID)).toEqual(
        staged.promptRef,
      );

      prepare.mockClear();
      await expect(
        fixture.store.bridge.prepare(
          workspaceBridgeInput(OTHER_ATTEMPT_ID, BASE_REVISION),
        ),
      ).rejects.toMatchObject({
        reasonCode: "ATTEMPT_INPUT_MISSING",
      });
      expect(prepare).not.toHaveBeenCalled();

      fixture.store.stage({
        attemptId: THIRD_ATTEMPT_ID,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        promptBytes: "staged without a captured commit",
        grants: [{ operation: "CREATE", relativePath: "src/third.ts" }],
      });
      await expect(
        fixture.store.bridge.prepare(
          workspaceBridgeInput(THIRD_ATTEMPT_ID, null),
        ),
      ).rejects.toMatchObject({
        reasonCode: "BASE_REVISION_UNAVAILABLE",
      });
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        fixture.store.bridge.prepare(
          workspaceBridgeInput(THIRD_ATTEMPT_ID, "a".repeat(64)),
        ),
      ).rejects.toMatchObject({ reasonCode: "BASE_REVISION_UNAVAILABLE" });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it("rejects a project or session mismatch before workspace.prepare", async () => {
    const prepare = vi.fn(
      async (_request: AttemptWorkspacePrepareRequestV1) => ({
        receipt: preparedReceipt(),
      }),
    );
    const fixture = createFixture({ prepare });
    try {
      fixture.store.stage({
        attemptId: ATTEMPT_ID,
        projectId: ADDRESS.projectId,
        sessionKey: ADDRESS.sessionKey,
        promptBytes: "private coding instruction",
        grants: [{ operation: "CREATE", relativePath: "src/new.ts" }],
      });

      await expect(
        fixture.store.bridge.prepare(
          workspaceBridgeInput(ATTEMPT_ID, BASE_REVISION, {
            ...ADDRESS,
            projectId: OTHER_PROJECT_ID,
          }),
        ),
      ).rejects.toMatchObject({ reasonCode: "ATTEMPT_BINDING_MISMATCH" });
      expect(prepare).not.toHaveBeenCalled();

      await expect(
        fixture.store.bridge.prepare(
          workspaceBridgeInput(ATTEMPT_ID, BASE_REVISION, {
            ...ADDRESS,
            sessionKey: OTHER_SESSION_KEY,
          }),
        ),
      ).rejects.toMatchObject({ reasonCode: "ATTEMPT_BINDING_MISMATCH" });
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });
});

const ATTEMPT_ID = "xhba_attempt_1" as AttemptId;
const OTHER_ATTEMPT_ID = "xhba_attempt_2" as AttemptId;
const THIRD_ATTEMPT_ID = "xhba_attempt_3" as AttemptId;
const BASE_REVISION = "a".repeat(40);
const ADDRESS = {
  projectId: `xgp1_${"b".repeat(64)}`,
  sessionKey: `xgs1_${"c".repeat(64)}`,
} as HubAddressV1;
const OTHER_PROJECT_ID = `xgp1_${"d".repeat(64)}` as HubAddressV1["projectId"];
const OTHER_SESSION_KEY =
  `xgs1_${"e".repeat(64)}` as HubAddressV1["sessionKey"];

function createFixture(overrides?: {
  prepare?: ReturnType<typeof vi.fn>;
  runtimeBinding?: ReturnType<typeof vi.fn>;
}) {
  const root = mkdtempSync(join(tmpdir(), "xiaogui-attempt-input-"));
  roots.push(root);
  const inputDbPath = join(root, "input.sqlite");
  const payloadDbPath = join(root, "payload.sqlite");
  const payloadVault = new PrivateRuntimePayloadVaultV1({
    dbPath: payloadDbPath,
  });
  const workspace = {
    prepare: overrides?.prepare ?? vi.fn(),
    runtimeBinding: overrides?.runtimeBinding ?? vi.fn(),
  } as unknown as AttemptWorkspacePortV1;
  const store = new AttemptExecutionInputStoreV1({
    dbPath: inputDbPath,
    payloadVault,
    workspace,
  });
  return {
    store,
    inputDbPath,
    payloadDbPath,
    close: () => {
      store.close();
      payloadVault.close();
    },
  };
}

function workspaceBridgeInput(
  attemptId: AttemptId,
  baseRevision: string | null,
  address: HubAddressV1 = ADDRESS,
): Parameters<ExecutionWorkspaceBridgeV1["prepare"]>[0] {
  return {
    address,
    attempt: {
      attempt_id: attemptId,
      task_run_id: "xhbtr_1",
      flow_id: "xhbf_1",
      status: "WORKSPACE_PREPARING",
      attempt_digest: "sha256:attempt",
      workspace_receipt_id: null,
      runtime_session_id: null,
      outcome_receipt_digest: null,
    },
    composition: {
      compositionAttemptId: "xhbca_1",
      attemptId,
      requestDigest: "sha256:request",
      baselineBindingDigest: "sha256:baseline-binding",
      compositionDigest: "sha256:composition",
    },
    baseline: {
      flow_id: "xhbf_1",
      baseline_id: "xhbb_1",
      base_revision: baseRevision,
      baseline_tree_hash: "sha256:tree",
      initial_target_fingerprint: "sha256:target",
      baseline_digest: "sha256:baseline",
      baseline_binding_digest: "sha256:baseline-binding",
    },
  } as Parameters<ExecutionWorkspaceBridgeV1["prepare"]>[0];
}

function preparedReceipt(): WorkspacePreparedReceiptM2BV1 {
  return {
    status: "PREPARED",
    workspaceReceiptId: "xhbw_1",
    receiptDigest: "sha256:receipt",
    compositionAttemptId: "xhbca_1",
    attemptId: ATTEMPT_ID,
    requestDigest: "sha256:request",
    baselineBindingDigest: "sha256:baseline-binding",
    compositionDigest: "sha256:composition",
  } as WorkspacePreparedReceiptM2BV1;
}

function workspaceBinding(): RuntimeWorkspaceBindingV1 {
  return {
    attemptWorktreeId: "xhbwt_1",
    worktreeRootDigest: "sha256:root",
    baseRevisionDigest: "sha256:base",
    targetProjectRootDigest: "sha256:project",
    writePolicy: "ATTEMPT_WORKTREE_ONLY",
  };
}

function mutateDb(dbPath: string, mutate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  try {
    mutate(db);
  } finally {
    db.close();
  }
}
