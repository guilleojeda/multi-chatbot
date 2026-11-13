import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import type { DocumentAction, DocumentErrorView, DocumentFileInput } from "../config/documents.js";

export type DocumentSourceRecord = {
  status: "confirmed";
  bucket: string;
  key: string;
  uri: string;
  sizeBytes: number;
  sha256: string;
};

export type DocumentOperationRecord = {
  operationId: string;
  documentId: string;
  action: DocumentAction;
  status:
    "awaiting_upload" | "pending_start" | "processing" | "completed" | "failed" | "unconfirmed";
  stage: "upload" | "validation" | "source" | "ingestion" | "result";
  revision: string;
  expectedRevision?: string | null;
  file?: DocumentFileInput & { contentType?: string };
  uploadKey?: string;
  candidateKey?: string;
  source?: DocumentSourceRecord | null;
  pendingRemovalKeys?: string[];
  sourceUrisToObserve?: string[];
  executionName?: string;
  executionInput?: { botId: string; operationId: string; step: "validate" | "promote" };
  executionArn?: string;
  ingestionClientToken?: string;
  ingestionJobId?: string;
  actorSub?: string;
  fingerprint?: string;
  canRetry: boolean;
  error?: DocumentErrorView;
  outcome?: "completed" | "failed" | "unconfirmed";
  createdAt?: number;
  updatedAt: number | string;
  [field: string]: unknown;
};

export type DocumentRecord = {
  documentId: string;
  state: "active" | "withdrawn";
  name: string;
  sizeBytes: number;
  revision: string;
  updatedAt: number | string;
  source: DocumentSourceRecord | null;
  pendingRemovalKeys: string[];
  canReplace?: boolean;
  sourceUrisToObserve?: string[];
  lastOperationId?: string;
  processing?: {
    status: "processing" | "completed" | "failed" | "unconfirmed";
    operationId: string;
    error?: DocumentErrorView;
  };
  canRetry?: boolean;
  [field: string]: unknown;
};

export type CreateDocumentIntentInput = {
  operationId: string;
  action: DocumentAction;
  actorSub: string;
  tokenExpiresAt: number;
  documentId: string;
  expectedRevision: string | null;
  candidateRevision: string;
  file?: DocumentFileInput & { contentType: string };
  uploadKey?: string;
  sourceUrisToObserve?: string[];
};

export type ReserveDocumentOperationInput = {
  operationId: string;
  documentId: string;
  action: DocumentAction;
  expectedRevision: string | null;
  candidateRevision?: string;
  candidateKey?: string;
  sourceUrisToObserve?: string[];
  executionName: string;
  executionInput: { botId: string; operationId: string; step: "validate" | "promote" };
};

export type DocumentStore = {
  listDocuments(input: { cursor: string | null; limit: number }): Promise<{
    documents: DocumentRecord[];
    nextCursor: string | null;
    activeOperation: DocumentOperationRecord | null;
    lastOperation: DocumentOperationRecord | null;
  }>;
  getDocument(input: { documentId: string }): Promise<DocumentRecord | null>;
  getOperation(input: { operationId: string }): Promise<DocumentOperationRecord | null>;
  createIntent(input: CreateDocumentIntentInput): Promise<{
    created: boolean;
    operation: DocumentOperationRecord;
  }>;
  reserveOperation(input: ReserveDocumentOperationInput): Promise<{
    reserved: boolean;
    operation: DocumentOperationRecord;
  }>;
  updateOperation(input: {
    operationId: string;
    patch: Partial<DocumentOperationRecord>;
  }): Promise<boolean>;
  recordSource(input: {
    operationId: string;
    source: DocumentSourceRecord | null;
    pendingRemovalKeys: string[];
  }): Promise<boolean>;
  recordIngestionJob(input: { operationId: string; jobId: string }): Promise<boolean>;
  finishOperation(input: {
    operationId: string;
    outcome: "completed" | "failed" | "unconfirmed";
    operation: DocumentOperationRecord;
  }): Promise<boolean>;
};

type DocumentClient = {
  send(command: object): Promise<unknown>;
};

type StoreOptions = {
  documentClient: DocumentClient;
  tableName: string;
  botId: string;
  now: () => number;
};

export function createDocumentStore(_options: StoreOptions): DocumentStore {
  const { documentClient, tableName, botId, now } = _options;
  const partition = `BOT#${botId}`;
  const documentKey = (documentId: string) => ({ pk: partition, sk: `DOCUMENT#${documentId}` });
  const operationKey = (operationId: string) => ({ pk: partition, sk: `OPERATION#${operationId}` });
  const controlKey = { pk: partition, sk: "CONTROL" };

  async function send(command: object): Promise<Record<string, unknown>> {
    return (await documentClient.send(command)) as Record<string, unknown>;
  }

  function rowRecord<T extends Record<string, unknown>>(
    row: Record<string, unknown> | undefined,
  ): T | null {
    if (!row) return null;
    const record = { ...row };
    delete record.pk;
    delete record.sk;
    delete record.botId;
    return record as T;
  }

  function publicTimestamp(value: unknown): string {
    const milliseconds =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
    if (!Number.isFinite(milliseconds)) {
      throw taggedError("DOCUMENTS_UNAVAILABLE", "A document timestamp is invalid.");
    }
    try {
      return new Date(milliseconds).toISOString();
    } catch {
      throw taggedError("DOCUMENTS_UNAVAILABLE", "A document timestamp is invalid.");
    }
  }

  function toDocument(row: Record<string, unknown>): DocumentRecord {
    const item = rowRecord<DocumentRecord>(row) as DocumentRecord;
    item.updatedAt = publicTimestamp(item.updatedAt);
    if (!Array.isArray(item.pendingRemovalKeys)) {
      throw taggedError("DOCUMENTS_UNAVAILABLE", "A document removal receipt is invalid.");
    }
    item.canReplace = item.state === "active" && item.pendingRemovalKeys.length === 0;
    return item;
  }

  function toOperation(row: Record<string, unknown>): DocumentOperationRecord {
    const item = rowRecord<DocumentOperationRecord>(row) as DocumentOperationRecord;
    item.updatedAt = publicTimestamp(item.updatedAt);
    return item;
  }

  async function getRow(key: { pk: string; sk: string }): Promise<Record<string, unknown> | null> {
    const result = await send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    );
    return result.Item && typeof result.Item === "object"
      ? (result.Item as Record<string, unknown>)
      : null;
  }

  function isConditionalFailure(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const value = error as { name?: unknown; CancellationReasons?: unknown };
    if (value.name === "ConditionalCheckFailedException") return true;
    return (
      value.name === "TransactionCanceledException" &&
      Array.isArray(value.CancellationReasons) &&
      value.CancellationReasons.some(
        (reason) =>
          typeof reason === "object" &&
          reason !== null &&
          (reason as { Code?: unknown }).Code === "ConditionalCheckFailed",
      )
    );
  }

  function taggedError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  function fingerprint(input: CreateDocumentIntentInput): string {
    const semantic = {
      action: input.action,
      ...(input.action !== "upload" ? { documentId: input.documentId } : {}),
      expectedRevision: input.expectedRevision,
      ...(input.file
        ? {
            file: {
              name: input.file.name,
              sizeBytes: input.file.sizeBytes,
              sha256: input.file.sha256,
            },
          }
        : {}),
    };
    return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
  }

  function operationPut(operation: DocumentOperationRecord): Record<string, unknown> {
    return {
      ...operationKey(operation.operationId),
      botId,
      ...operation,
    };
  }

  function fieldsToExpression(fields: Record<string, unknown>, prefix: string) {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const updates: string[] = [];
    let index = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined || ["pk", "sk", "botId"].includes(field)) continue;
      const name = `#${prefix}n${index}`;
      const token = `:${prefix}v${index}`;
      names[name] = field;
      values[token] = value;
      updates.push(`${name} = ${token}`);
      index += 1;
    }
    return { names, values, updates };
  }

  function decodeCursor(cursor: string | null): Record<string, unknown> | undefined {
    if (cursor === null) return undefined;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Record<string, unknown>).pk !== partition ||
        typeof (parsed as Record<string, unknown>).sk !== "string"
      ) {
        throw new Error("Invalid cursor");
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw taggedError("INVALID_INPUT", "The document cursor is invalid.");
    }
  }

  return {
    async listDocuments({ cursor, limit }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw taggedError("INVALID_INPUT", "The document page size is invalid.");
      }
      const exclusiveStartKey = decodeCursor(cursor);
      const query = await send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: { ":pk": partition, ":prefix": "DOCUMENT#" },
          Limit: limit,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
        }),
      );
      const rows = Array.isArray(query.Items) ? (query.Items as Record<string, unknown>[]) : [];
      const documents = rows.filter((row) => row.state !== "withdrawn").map(toDocument);
      const nextCursor = query.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(query.LastEvaluatedKey)).toString("base64url")
        : null;
      const control = await getRow(controlKey);
      const activeOperationId =
        control && typeof control.activeOperationId === "string" ? control.activeOperationId : null;
      const lastOperationId =
        control && typeof control.lastOperationId === "string" ? control.lastOperationId : null;
      const [activeRow, lastRow] = await Promise.all([
        activeOperationId ? getRow(operationKey(activeOperationId)) : Promise.resolve(null),
        lastOperationId ? getRow(operationKey(lastOperationId)) : Promise.resolve(null),
      ]);
      return {
        documents,
        nextCursor,
        activeOperation: activeRow ? toOperation(activeRow) : null,
        lastOperation: lastRow ? toOperation(lastRow) : null,
      };
    },

    async getDocument({ documentId }) {
      const row = await getRow(documentKey(documentId));
      return row ? toDocument(row) : null;
    },

    async getOperation({ operationId }) {
      const row = await getRow(operationKey(operationId));
      return row ? toOperation(row) : null;
    },

    async createIntent(input) {
      const createdAt = now();
      const operationFingerprint = fingerprint(input);
      const existing = await this.getOperation({ operationId: input.operationId });
      if (existing) {
        if (existing.fingerprint !== operationFingerprint) {
          throw taggedError(
            "STATE_CHANGED",
            "The operation ID already belongs to another request.",
          );
        }
        return { created: false, operation: existing };
      }
      const operation: DocumentOperationRecord = {
        operationId: input.operationId,
        documentId: input.documentId,
        action: input.action,
        status:
          input.action === "upload" || input.action === "replace"
            ? "awaiting_upload"
            : "pending_start",
        stage: input.action === "upload" || input.action === "replace" ? "upload" : "source",
        revision: input.candidateRevision,
        expectedRevision: input.expectedRevision,
        ...(input.file ? { file: input.file } : {}),
        ...(input.uploadKey ? { uploadKey: input.uploadKey } : {}),
        ...(input.sourceUrisToObserve
          ? { sourceUrisToObserve: [...new Set(input.sourceUrisToObserve)] }
          : {}),
        actorSub: input.actorSub,
        fingerprint: operationFingerprint,
        canRetry: false,
        createdAt,
        updatedAt: createdAt,
      };
      try {
        await send(
          new PutCommand({
            TableName: tableName,
            Item: operationPut(operation),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          }),
        );
        return { created: true, operation: toOperation(operationPut(operation)) };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const current = await this.getOperation({ operationId: input.operationId });
        if (!current)
          throw taggedError(
            "DOCUMENT_OPERATION_UNCONFIRMED",
            "The operation receipt is unavailable.",
          );
        if (current.fingerprint !== operationFingerprint) {
          throw taggedError(
            "STATE_CHANGED",
            "The operation ID already belongs to another request.",
          );
        }
        return { created: false, operation: current };
      }
    },

    async reserveOperation(input) {
      const [operationRow, documentRow, controlRow] = await Promise.all([
        getRow(operationKey(input.operationId)),
        getRow(documentKey(input.documentId)),
        getRow(controlKey),
      ]);
      if (!operationRow) throw taggedError("NOT_FOUND", "The operation was not found.");
      const operation = toOperation(operationRow);
      const document = documentRow ? toDocument(documentRow) : null;
      const activeOwner =
        controlRow && typeof controlRow.activeOperationId === "string"
          ? controlRow.activeOperationId
          : null;
      if (activeOwner && activeOwner !== input.operationId) {
        throw taggedError("DOCUMENT_OPERATION_ACTIVE", "Another document operation is active.");
      }
      if (activeOwner === input.operationId && operation.status === "processing") {
        return { reserved: false, operation };
      }
      if (operation.status !== "awaiting_upload" && operation.status !== "pending_start") {
        if (operation.status === "completed" || operation.status === "failed") {
          return { reserved: false, operation };
        }
        throw taggedError(
          "DOCUMENT_OPERATION_UNCONFIRMED",
          "The operation reservation is uncertain.",
        );
      }
      if (input.action !== operation.action || operation.documentId !== input.documentId) {
        throw taggedError(
          "STATE_CHANGED",
          "The operation does not match the requested document change.",
        );
      }
      if (input.expectedRevision === null) {
        if (documentRow) throw taggedError("STATE_CHANGED", "The document already exists.");
      } else if (
        !document ||
        document.state !== "active" ||
        document.revision !== input.expectedRevision ||
        operation.expectedRevision !== input.expectedRevision
      ) {
        throw taggedError("STATE_CHANGED", "The document revision changed.");
      }
      if (input.action === "replace" && document && document.pendingRemovalKeys.length > 0) {
        throw taggedError("STATE_CHANGED", "Pending source removal must be resolved first.");
      }
      const hasSourceReceipt =
        input.sourceUrisToObserve !== undefined || operation.sourceUrisToObserve !== undefined;
      const sourceUrisToObserve = [
        ...new Set(input.sourceUrisToObserve ?? operation.sourceUrisToObserve ?? []),
      ];
      const reservedAt = now();
      const nextOperation = {
        ...operation,
        status: "processing" as const,
        stage:
          input.executionInput.step === "validate" ? ("validation" as const) : ("source" as const),
        expectedRevision: input.expectedRevision,
        ...(input.candidateRevision ? { revision: input.candidateRevision } : {}),
        ...(input.candidateKey ? { candidateKey: input.candidateKey } : {}),
        ...(hasSourceReceipt ? { sourceUrisToObserve } : {}),
        executionName: input.executionName,
        executionInput: input.executionInput,
        ownerOperationId: input.operationId,
        updatedAt: reservedAt,
      };
      const controlUpdate = new UpdateCommand({
        TableName: tableName,
        Key: controlKey,
        UpdateExpression: "SET #active = :operationId, #updatedAt = :updatedAt",
        ConditionExpression: "attribute_not_exists(#active)",
        ExpressionAttributeNames: { "#active": "activeOperationId", "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":operationId": input.operationId, ":updatedAt": reservedAt },
      });
      const operationFields: Record<string, unknown> = {
        status: "processing",
        stage: nextOperation.stage,
        expectedRevision: input.expectedRevision,
        revision: nextOperation.revision,
        ...(input.candidateKey ? { candidateKey: input.candidateKey } : {}),
        ...(hasSourceReceipt ? { sourceUrisToObserve } : {}),
        executionName: input.executionName,
        executionInput: input.executionInput,
        ownerOperationId: input.operationId,
        updatedAt: reservedAt,
      };
      const operationExpression = fieldsToExpression(operationFields, "r");
      const operationUpdate = new UpdateCommand({
        TableName: tableName,
        Key: operationKey(input.operationId),
        UpdateExpression: `SET ${operationExpression.updates.join(", ")}`,
        ConditionExpression:
          "#operationId = :operationId AND (#requiredStatus = :pendingStart OR #requiredStatus = :awaitingUpload)",
        ExpressionAttributeNames: {
          ...operationExpression.names,
          "#requiredStatus": "status",
          "#operationId": "operationId",
        },
        ExpressionAttributeValues: {
          ...operationExpression.values,
          ":operationId": input.operationId,
          ":pendingStart": "pending_start",
          ":awaitingUpload": "awaiting_upload",
        },
      });
      const transactionItems: Record<string, unknown>[] = [
        { Update: controlUpdate.input },
        { Update: operationUpdate.input },
      ];
      if (documentRow) {
        const documentConditionParts = ["#revision = :revision", "#state = :active"];
        const documentNames: Record<string, string> = {
          "#owner": "ownerOperationId",
          "#updatedAt": "updatedAt",
          "#revision": "revision",
          "#state": "state",
        };
        const documentValues: Record<string, unknown> = {
          ":owner": input.operationId,
          ":updatedAt": reservedAt,
          ":revision": input.expectedRevision,
          ":active": "active",
        };
        if (input.action === "replace") {
          documentConditionParts.push(
            "(attribute_not_exists(#pendingKeys) OR size(#pendingKeys) = :emptyList)",
          );
          documentNames["#pendingKeys"] = "pendingRemovalKeys";
          documentValues[":emptyList"] = 0;
        }
        if (input.action === "reprocess") {
          documentConditionParts.push("#source.#sourceStatus = :confirmedSource");
          documentNames["#source"] = "source";
          documentNames["#sourceStatus"] = "status";
          documentValues[":confirmedSource"] = "confirmed";
        }
        const check = new UpdateCommand({
          TableName: tableName,
          Key: documentKey(input.documentId),
          UpdateExpression: "SET #owner = :owner, #updatedAt = :updatedAt",
          ConditionExpression: documentConditionParts.join(" AND "),
          ExpressionAttributeNames: documentNames,
          ExpressionAttributeValues: documentValues,
        });
        transactionItems.push({ Update: check.input });
      } else {
        transactionItems.push({
          ConditionCheck: {
            TableName: tableName,
            Key: documentKey(input.documentId),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        });
      }
      try {
        await send(new TransactWriteCommand({ TransactItems: transactionItems as never[] }));
        return {
          reserved: true,
          operation: { ...nextOperation, updatedAt: publicTimestamp(reservedAt) },
        };
      } catch (error) {
        if (isConditionalFailure(error)) {
          const latestControl = await getRow(controlKey).catch(() => null);
          if (
            latestControl?.activeOperationId &&
            latestControl.activeOperationId !== input.operationId
          ) {
            throw taggedError("DOCUMENT_OPERATION_ACTIVE", "Another document operation is active.");
          }
          throw taggedError(
            "STATE_CHANGED",
            "The document or operation changed before reservation.",
          );
        }
        throw error;
      }
    },

    async updateOperation({ operationId, patch }) {
      const updatedAt = now();
      const values = { ...patch, updatedAt } as Record<string, unknown>;
      delete values.operationId;
      delete values.documentId;
      delete values.action;
      delete values.revision;
      const expression = fieldsToExpression(values, "p");
      if (expression.updates.length === 0) return false;
      const names = { ...expression.names, "#ownerOperationId": "ownerOperationId" };
      const attributeValues = {
        ...expression.values,
        ":ownerOperationId": operationId,
        ":completed": "completed",
        ":failed": "failed",
      };
      try {
        await send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: tableName,
                  Key: controlKey,
                  ConditionExpression: "#activeOperationId = :ownerOperationId",
                  ExpressionAttributeNames: { "#activeOperationId": "activeOperationId" },
                  ExpressionAttributeValues: { ":ownerOperationId": operationId },
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: operationKey(operationId),
                  UpdateExpression: `SET ${expression.updates.join(", ")}`,
                  ConditionExpression:
                    "#ownerOperationId = :ownerOperationId AND #status <> :completed AND #status <> :failed",
                  ExpressionAttributeNames: { ...names, "#status": "status" },
                  ExpressionAttributeValues: attributeValues,
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async recordSource({ operationId, source, pendingRemovalKeys }) {
      const operationRow = await getRow(operationKey(operationId));
      if (!operationRow) return false;
      const operation = toOperation(operationRow);
      const documentId = operation.documentId;
      const documentRow = await getRow(documentKey(documentId));
      const priorDocument = documentRow ? toDocument(documentRow) : null;
      const sourceUrisToObserve = [
        ...new Set([
          ...(priorDocument?.sourceUrisToObserve ?? []),
          ...(operation.sourceUrisToObserve ?? []),
        ]),
      ];
      const updatedAt = now();
      const nextDocument: Record<string, unknown> = {
        documentId,
        state: "active",
        name: operation.file?.name ?? priorDocument?.name ?? "",
        sizeBytes: operation.file?.sizeBytes ?? priorDocument?.sizeBytes ?? 0,
        revision: operation.revision,
        source,
        pendingRemovalKeys: [...new Set(pendingRemovalKeys)],
        ...(sourceUrisToObserve.length ? { sourceUrisToObserve } : {}),
        lastOperationId: operationId,
        processing: { status: "processing", operationId },
        ownerOperationId: operationId,
        updatedAt,
      };
      const operationUpdate = new UpdateCommand({
        TableName: tableName,
        Key: operationKey(operationId),
        UpdateExpression: "SET #source = :source, #pending = :pending, #updatedAt = :updatedAt",
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: {
          "#source": "source",
          "#pending": "pendingRemovalKeys",
          "#updatedAt": "updatedAt",
          "#owner": "ownerOperationId",
        },
        ExpressionAttributeValues: {
          ":source": source,
          ":pending": [...new Set(pendingRemovalKeys)],
          ":updatedAt": updatedAt,
          ":owner": operationId,
        },
      });
      const controlCheck = {
        ConditionCheck: {
          TableName: tableName,
          Key: controlKey,
          ConditionExpression: "#active = :owner",
          ExpressionAttributeNames: { "#active": "activeOperationId" },
          ExpressionAttributeValues: { ":owner": operationId },
        },
      };
      const documentCommand = priorDocument
        ? new UpdateCommand({
            TableName: tableName,
            Key: documentKey(documentId),
            UpdateExpression:
              "SET #state = :state, #name = :name, #size = :size, #revision = :revision, #source = :source, #pending = :pending, #sourceUris = :sourceUris, #last = :last, #processing = :processing, #owner = :owner, #updatedAt = :updatedAt",
            ConditionExpression: "#owner = :owner",
            ExpressionAttributeNames: {
              "#state": "state",
              "#name": "name",
              "#size": "sizeBytes",
              "#revision": "revision",
              "#source": "source",
              "#pending": "pendingRemovalKeys",
              "#sourceUris": "sourceUrisToObserve",
              "#last": "lastOperationId",
              "#processing": "processing",
              "#owner": "ownerOperationId",
              "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues: {
              ":state": nextDocument.state,
              ":name": nextDocument.name,
              ":size": nextDocument.sizeBytes,
              ":revision": nextDocument.revision,
              ":source": source,
              ":pending": nextDocument.pendingRemovalKeys,
              ":sourceUris": sourceUrisToObserve,
              ":last": operationId,
              ":processing": nextDocument.processing,
              ":owner": operationId,
              ":updatedAt": updatedAt,
            },
          })
        : new PutCommand({
            TableName: tableName,
            Item: { ...documentKey(documentId), botId, ...nextDocument },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          });
      try {
        await send(
          new TransactWriteCommand({
            TransactItems: [
              controlCheck,
              { Update: operationUpdate.input },
              documentCommand instanceof PutCommand
                ? { Put: documentCommand.input }
                : { Update: documentCommand.input },
            ] as never[],
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) return false;
        throw error;
      }
    },

    async recordIngestionJob({ operationId, jobId }) {
      return this.updateOperation({ operationId, patch: { ingestionJobId: jobId } });
    },

    async finishOperation({ operationId, outcome, operation: suppliedOperation }) {
      const [operationRow, controlRow] = await Promise.all([
        getRow(operationKey(operationId)),
        getRow(controlKey),
      ]);
      const operation = suppliedOperation ?? (operationRow ? toOperation(operationRow) : null);
      if (!operation) return false;
      const documentId = operation.documentId;
      const documentRow = documentId ? await getRow(documentKey(documentId)) : null;
      const document = documentRow ? toDocument(documentRow) : null;
      if (!documentRow && !(operation.action === "upload" && outcome === "failed")) {
        return false;
      }
      const updatedAt = now();
      const finalStatus = outcome === "completed" ? "completed" : outcome;
      const finalOperation = {
        ...operation,
        status: finalStatus,
        stage: "result" as const,
        outcome,
        updatedAt,
        ownerOperationId: operationId,
      };
      const finalFields = { ...finalOperation } as Record<string, unknown>;
      delete finalFields.operationId;
      delete finalFields.documentId;
      delete finalFields.action;
      delete finalFields.revision;
      delete finalFields.ownerOperationId;
      const operationExpression = fieldsToExpression(finalFields, "f");
      const operationUpdate = new UpdateCommand({
        TableName: tableName,
        Key: operationKey(operationId),
        UpdateExpression: `SET ${operationExpression.updates.join(", ")}`,
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: {
          ...operationExpression.names,
          "#owner": "ownerOperationId",
        },
        ExpressionAttributeValues: {
          ...operationExpression.values,
          ":owner": operationId,
        },
      });
      const controlUpdate = new UpdateCommand({
        TableName: tableName,
        Key: controlKey,
        UpdateExpression: "SET #last = :last, #updatedAt = :updatedAt REMOVE #active",
        ConditionExpression: "#active = :owner",
        ExpressionAttributeNames: {
          "#last": "lastOperationId",
          "#updatedAt": "updatedAt",
          "#active": "activeOperationId",
        },
        ExpressionAttributeValues: {
          ":last": operationId,
          ":updatedAt": updatedAt,
          ":owner": operationId,
        },
      });
      const transactionItems: Record<string, unknown>[] = [
        { Update: operationUpdate.input },
        { Update: controlUpdate.input },
      ];
      if (documentRow && document) {
        const withdrawn = operation.action === "withdraw" && outcome === "completed";
        const processingStatus = outcome === "unconfirmed" ? "unconfirmed" : outcome;
        const documentUpdate = new UpdateCommand({
          TableName: tableName,
          Key: documentKey(documentId),
          UpdateExpression:
            "SET #state = :state, #source = :source, #pending = :pending, #sourceUris = :sourceUris, #last = :last, #processing = :processing, #canRetry = :canRetry, #updatedAt = :updatedAt",
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: {
            "#state": "state",
            "#source": "source",
            "#pending": "pendingRemovalKeys",
            "#sourceUris": "sourceUrisToObserve",
            "#last": "lastOperationId",
            "#processing": "processing",
            "#canRetry": "canRetry",
            "#updatedAt": "updatedAt",
            "#owner": "ownerOperationId",
          },
          ExpressionAttributeValues: {
            ":state": withdrawn ? "withdrawn" : "active",
            ":source": document.source ?? operation.source ?? null,
            ":pending": document.pendingRemovalKeys ?? operation.pendingRemovalKeys ?? [],
            ":sourceUris": [
              ...new Set([
                ...(document.sourceUrisToObserve ?? []),
                ...(operation.sourceUrisToObserve ?? []),
              ]),
            ],
            ":last": operationId,
            ":processing": {
              status: processingStatus,
              operationId,
              ...(finalOperation.error ? { error: finalOperation.error } : {}),
            },
            ":canRetry": Boolean(finalOperation.canRetry),
            ":updatedAt": updatedAt,
            ":owner": operationId,
          },
        });
        transactionItems.push({ Update: documentUpdate.input });
      }
      try {
        await send(new TransactWriteCommand({ TransactItems: transactionItems as never[] }));
        return true;
      } catch (error) {
        if (isConditionalFailure(error)) {
          const latestControl = controlRow ? controlRow.activeOperationId : null;
          if (latestControl !== operationId) return false;
          return false;
        }
        throw error;
      }
    },
  };
}
