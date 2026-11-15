import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const workerPath = path.join(projectRoot, "api/records-export-worker.ts");
const botId = "docentes";
const tableName = "dev-docentes-conversations";
const recordsIndexName = "RecordsByBotAndCreatedAt";
const bucket = "dev-docentes-temporary";
const actorSub = "global-admin-123";
const exportId = "f9785c25-515d-43e0-b649-cad435355b50";
const conversationId = "550e8400-e29b-41d4-a716-446655440000";
const testConversationId = "650e8400-e29b-41d4-a716-446655440001";
const queryIds = [
  "a4bfbc9f-3699-4a93-b120-a03c0204bc67",
  "b0d7cf70-ae36-49f4-a1b9-2837633a54ca",
  "d1be8d71-8d1c-4ed3-9ad0-f20fbfbb90be",
  "e9a71af4-a1ed-4e8e-81a9-91251be07d94",
];
const fixedNow = Date.parse("2026-10-25T18:00:30.000Z");

let createRecordsExportWorker;

beforeAll(async () => {
  if (!existsSync(workerPath)) return;
  const module = await import(pathToFileURL(workerPath).href);
  createRecordsExportWorker = module.createRecordsExportWorker;
});

beforeEach(() => {
  expect(
    typeof createRecordsExportWorker,
    "producto ausente: se espera api/records-export-worker.ts#createRecordsExportWorker",
  ).toBe("function");
});

afterEach(() => vi.restoreAllMocks());

function key(pk, sk) {
  return `${pk}\u0000${sk}`;
}

function makeMeta(id, ownerSub, lastOrdinal, overrides = {}) {
  return {
    pk: `CONV#${id}`,
    sk: "META",
    conversationId: id,
    sub: ownerSub,
    botId,
    createdAt: "2026-10-25T02:59:59.999Z",
    updatedAt: "2026-10-25T18:00:00.000Z",
    lastOrdinal,
    closed: false,
    ...overrides,
  };
}

function makeProfile(ownerSub, fields, responsePreferenceIds = []) {
  return {
    sub: ownerSub,
    botId,
    fields,
    responsePreferenceIds,
    promptTexts: responsePreferenceIds.map((id) => `prompt for ${id}`),
    updatedAt: "2026-10-20T14:00:00.000Z",
    configurationRevision: "profile-config-9",
  };
}

const oldProfile = makeProfile(
  "teacher-legacy",
  {
    educationLevels: [{ id: "secundario", label: "Secundario" }],
    subjects: ["Matemática"],
  },
  ["step-by-step"],
);
const matchingProfile = makeProfile(
  "teacher-legacy",
  {
    educationLevels: [{ id: "primario", label: "Primario" }],
    subjects: ["Ciencias, naturales"],
  },
  ["brief-practical"],
);

function makeTurn(id, ownerSub, ordinal, overrides = {}) {
  const queryId = queryIds[ordinal - 1];
  const status = overrides.status ?? "completed";
  const answerCount = overrides.answerCount ?? 1;
  const createdAt = overrides.createdAt ?? "2026-10-25T12:00:00.000Z";
  return {
    pk: `CONV#${id}`,
    sk: `TURN#${String(ordinal).padStart(8, "0")}`,
    conversationId: id,
    sub: ownerSub,
    botId,
    queryId,
    operation: ordinal === 1 ? "start" : "message",
    baseOrdinal: ordinal - 1,
    ordinal,
    requestFingerprint: "a".repeat(64),
    ownerAttemptId: `attempt-${ordinal}`,
    resultDeadlineAt: Date.parse(createdAt) + 120_000,
    status,
    phase:
      status === "completed" ? "complete" : status === "failed" ? "failed" : "invocation_claimed",
    cursor: answerCount,
    createdAt,
    updatedAt: createdAt,
    questionManifest: { count: 1, complete: true },
    answerManifest: { count: answerCount, complete: status === "completed" },
    contextManifest: { count: 0, complete: true },
    documentContextManifest: { count: 1, complete: true },
    contextSnapshot: { version: 1, recentReferences: [] },
    profileSnapshot: makeProfile(
      ownerSub,
      matchingProfile.fields,
      matchingProfile.responsePreferenceIds,
    ),
    invocation: { modelId: "global.anthropic.claude-sonnet-4-6", revision: "runtime-12" },
    ...overrides,
  };
}

function makeTextChunk(turn, role, index, text) {
  return {
    pk: turn.pk,
    sk: `${turn.sk}#${turn.queryId}#${role.toUpperCase()}#` + String(index).padStart(8, "0"),
    conversationId: turn.conversationId,
    ordinal: turn.ordinal,
    queryId: turn.queryId,
    role,
    index,
    text,
    createdAt: turn.createdAt,
  };
}

function makeIndexRow(turn) {
  return {
    pk: turn.pk,
    sk: turn.sk,
    botId: turn.botId,
    createdAt: turn.createdAt,
    conversationId: turn.conversationId,
    ordinal: turn.ordinal,
  };
}

function seedMainRecords() {
  const first = makeTurn(conversationId, "teacher-legacy", 1, {
    createdAt: "2026-10-25T02:59:59.999Z",
    profileSnapshot: oldProfile,
  });
  const failed = makeTurn(conversationId, "teacher-legacy", 2, {
    status: "failed",
    phase: "failed",
    createdAt: "2026-10-25T03:00:00.000Z",
    failure: { code: "provider_failed" },
  });
  const active = makeTurn(conversationId, "teacher-legacy", 3, {
    status: "in_progress",
    phase: "invocation_claimed",
    createdAt: "2026-10-25T18:00:00.000Z",
  });
  const testTurn = makeTurn(testConversationId, "team-test-sub", 1, {
    createdAt: "2026-10-25T17:00:00.000Z",
  });
  const records = [
    makeMeta(conversationId, "teacher-legacy", 3, {
      hiddenAt: "2026-10-25T18:00:10.000Z",
      closed: false,
    }),
    first,
    failed,
    active,
    makeTextChunk(first, "user", 0, 'Pregunta inicial,\npara 5.º: "raíces"'),
    makeTextChunk(first, "assistant", 0, 'La raíz ordena las partes,\ny conserva "el sentido".'),
    makeTextChunk(failed, "user", 0, "¿Y para primaria?"),
    makeTextChunk(failed, "assistant", 0, 'Respuesta parcial,\ncon "cierre".'),
    makeTextChunk(active, "user", 0, "=SUM(1,1)"),
    makeTextChunk(active, "assistant", 0, "Prefijo durable"),
    makeMeta(testConversationId, "team-test-sub", 1),
    testTurn,
    makeTextChunk(testTurn, "user", 0, "Consulta de prueba"),
    makeTextChunk(testTurn, "assistant", 0, "Respuesta de prueba"),
  ];
  return { records, first, failed, active, testTurn };
}

function expressions(command) {
  return {
    names: command.input.ExpressionAttributeNames ?? {},
    values: command.input.ExpressionAttributeValues ?? {},
    expression: command.input.KeyConditionExpression ?? "",
  };
}

function baseQueryItems(command, records, requestedTable) {
  const { names, values, expression } = expressions(command);
  const partitionName = names["#pk"] ?? "pk";
  const partition =
    values[":pk"] ??
    Object.values(values).find((value) => typeof value === "string" && value.startsWith("CONV#"));
  if (typeof partition !== "string")
    throw new Error("Mock Query must identify one conversation partition.");
  const sortName = names["#sk"] ?? "sk";
  let items = records.filter((item) => item[partitionName] === partition && item.pk === partition);
  const beginsWith = expression.match(/begins_with\(\s*#?\w+\s*,\s*(:\w+)\s*\)/);
  if (beginsWith) {
    const prefix = values[beginsWith[1]];
    items = items.filter((item) => String(item[sortName]).startsWith(String(prefix)));
  } else {
    const exactSort = Object.entries(values).find(
      ([name, value]) =>
        expression.includes(`= ${name}`) && typeof value === "string" && value.startsWith("TURN#"),
    )?.[1];
    if (typeof exactSort === "string") items = items.filter((item) => item[sortName] === exactSort);
  }
  items.sort((left, right) => String(left.sk).localeCompare(String(right.sk)));

  const startKey = command.input.ExclusiveStartKey;
  const startIndex = startKey
    ? items.findIndex((item) => item.pk === startKey.pk && item.sk === startKey.sk) + 1
    : 0;
  const limit =
    Number.isSafeInteger(command.input.Limit) && command.input.Limit > 0
      ? command.input.Limit
      : 500;
  const page = items.slice(startIndex, startIndex + limit).map((item) => structuredClone(item));
  const lastIndex = startIndex + page.length - 1;
  return {
    Items: page,
    ...(lastIndex < items.length - 1
      ? { LastEvaluatedKey: { pk: page.at(-1).pk, sk: page.at(-1).sk } }
      : {}),
    TableName: requestedTable,
  };
}

function makeDocumentClient({ records, indexPages, afterRead, failConversationRead = false }) {
  const byKey = new Map(records.map((item) => [key(item.pk, item.sk), structuredClone(item)]));
  const commands = [];
  const indexRequests = [];
  const seenMeta = new Set();
  const seenTurns = new Set();
  const database = {
    get(pk, sk) {
      const item = byKey.get(key(pk, sk));
      return item === undefined ? undefined : structuredClone(item);
    },
    set(item) {
      byKey.set(key(item.pk, item.sk), structuredClone(item));
    },
    all() {
      return [...byKey.values()].map((item) => structuredClone(item));
    },
  };

  function afterReturnedSnapshot(items, command) {
    for (const item of items.filter(Boolean)) {
      if (item.sk === "META" && !seenMeta.has(item.pk)) {
        seenMeta.add(item.pk);
        afterRead?.({ item: structuredClone(item), command, database, kind: "meta" });
      }
      if (/^TURN#\d{8}$/.test(item.sk) && !seenTurns.has(key(item.pk, item.sk))) {
        seenTurns.add(key(item.pk, item.sk));
        afterRead?.({ item: structuredClone(item), command, database, kind: "turn" });
      }
    }
  }

  const send = vi.fn(async (command) => {
    commands.push(command);
    if (command instanceof QueryCommand && command.input.IndexName === recordsIndexName) {
      indexRequests.push(command);
      const page = indexPages[indexRequests.length - 1] ?? { Items: [] };
      return structuredClone(page);
    }

    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input;
      if (TableName !== tableName) throw new Error(`Unexpected table ${TableName}.`);
      if (failConversationRead && Key.pk === `CONV#${conversationId}`) {
        throw new Error("simulated conversation read failure");
      }
      const item = database.get(Key.pk, Key.sk);
      afterReturnedSnapshot(item ? [item] : [], command);
      return item ? { Item: item } : {};
    }

    if (command instanceof BatchGetCommand) {
      const responses = {};
      for (const [requestedTable, request] of Object.entries(command.input.RequestItems)) {
        if (requestedTable !== tableName) throw new Error(`Unexpected table ${requestedTable}.`);
        if (
          failConversationRead &&
          request.Keys.some((requestedKey) => requestedKey.pk === `CONV#${conversationId}`)
        ) {
          throw new Error("simulated conversation read failure");
        }
        const items = request.Keys.map((requestedKey) =>
          database.get(requestedKey.pk, requestedKey.sk),
        ).filter(Boolean);
        responses[requestedTable] = items;
        afterReturnedSnapshot(items, command);
      }
      return { Responses: responses };
    }

    if (command instanceof QueryCommand) {
      const { values } = expressions(command);
      const partition =
        values[":pk"] ??
        Object.values(values).find(
          (value) => typeof value === "string" && value.startsWith("CONV#"),
        );
      if (typeof partition !== "string") throw new Error("Unexpected Query partition.");
      if (failConversationRead && partition === `CONV#${conversationId}`) {
        throw new Error("simulated conversation read failure");
      }
      const page = baseQueryItems(command, database.all(), tableName);
      afterReturnedSnapshot(page.Items ?? [], command);
      return page;
    }

    throw new Error(`Unexpected DynamoDB command ${command.constructor.name}.`);
  });

  return { documentClient: { send }, commands, indexRequests, database };
}

async function collectCsv({ body }) {
  expect(typeof body?.[Symbol.asyncIterator], "publishCsv body must be an async iterable").toBe(
    "function",
  );
  const chunks = [];
  for await (const chunk of body) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (ArrayBuffer.isView(chunk)) {
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } else {
      throw new TypeError("CSV stream yielded a non-UTF-8 chunk.");
    }
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, csv: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

function makeWorkerHarness({
  records = [],
  indexPages = [],
  afterRead,
  failConversationRead = false,
} = {}) {
  const client = makeDocumentClient({ records, indexPages, afterRead, failConversationRead });
  const published = [];
  const publishCsv = vi.fn(async (input) => {
    const captured = await collectCsv(input);
    published.push({ ...input, ...captured });
    return { eTag: '"records-export-etag"' };
  });
  const worker = createRecordsExportWorker({
    environment: "dev",
    resourcesByBot: {
      [botId]: {
        conversationTableName: tableName,
        recordsIndexName,
        documentUploadBucketName: bucket,
        testPersonIds: ["team-test-sub"],
      },
    },
    documentClient: client.documentClient,
    publishCsv,
    now: () => fixedNow,
  });
  return { worker, publishCsv, published, ...client };
}

const filters = {
  from: "2026-10-25",
  to: "2026-10-25",
  status: "failed",
  personId: "teacher-legacy",
  levelId: "primario",
  subject: "  CIENCIAS, NATURALES  ",
  excludeTests: true,
};

function makeIndexPages({ matchingTurn, trailingTurn, testTurn, gapTurn }) {
  const firstKey = makeIndexRow(matchingTurn);
  const gapKey = makeIndexRow(gapTurn);
  return [
    { Items: [firstKey], LastEvaluatedKey: firstKey },
    { Items: [], LastEvaluatedKey: gapKey },
    { Items: [makeIndexRow(trailingTurn), makeIndexRow(testTurn)] },
  ];
}

function addConcurrentTail({ item, database, kind }) {
  if (item.pk !== `CONV#${conversationId}`) return;
  if (kind === "turn" && item.sk === "TURN#00000003") {
    const active = database.get(item.pk, item.sk);
    active.cursor = 2;
    active.answerManifest = { count: 2, complete: false };
    active.updatedAt = "2026-10-25T18:00:40.000Z";
    database.set(active);
    const appendedChunk = makeTextChunk(active, "assistant", 1, " after the pinned prefix");
    appendedChunk.createdAt = "2026-10-25T18:00:40.000Z";
    database.set(appendedChunk);
  }
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field !== "") throw new Error("CSV quote started inside an unquoted field.");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r" && csv[index + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
    } else if (character === "\r" || character === "\n") {
      throw new Error("CSV records must use CRLF separators; embedded line breaks must be quoted.");
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("admin record export worker acceptance", () => {
  it("exports each full hidden thread once as exact UTF-8 CSV from the pinned answer prefix", async () => {
    const { records, failed, active, testTurn } = seedMainRecords();
    const gapTurn = makeTurn("750e8400-e29b-41d4-a716-446655440002", "other-teacher", 1, {
      createdAt: "2026-10-25T14:00:00.000Z",
    });
    const indexPages = makeIndexPages({
      matchingTurn: failed,
      trailingTurn: active,
      testTurn,
      gapTurn,
    });
    const harness = makeWorkerHarness({
      records: [...records, makeMeta(gapTurn.conversationId, gapTurn.sub, 1), gapTurn],
      indexPages,
      afterRead: addConcurrentTail,
    });

    const result = await harness.worker.run({ botId, actorSub, exportId, filters });

    expect(result).toMatchObject({
      status: "ready",
      conversationCount: 1,
      rowCount: 3,
      eTag: '"records-export-etag"',
    });
    expect(harness.publishCsv).toHaveBeenCalledTimes(1);
    expect(harness.published).toHaveLength(1);
    expect(harness.published[0].bucket).toBe(bucket);
    expect(harness.published[0].key).toMatch(/^exports\//);
    expect(harness.published[0].contentType).toMatch(/^text\/csv(?:;\s*charset=utf-8)?$/i);
    const csvRows = parseCsv(harness.published[0].csv);
    expect(csvRows[0]).toEqual([
      "id_persona",
      "id_conversacion",
      "id_consulta",
      "orden",
      "admitida_en",
      "estado",
      "respuesta_completa",
      "codigo_fallo",
      "pregunta",
      "respuesta",
      "contexto_profesional",
      "es_prueba",
      "coincide_filtros",
    ]);
    expect(csvRows.slice(1).map((row) => row.slice(0, 10).concat(row.slice(11)))).toEqual([
      [
        "teacher-legacy",
        conversationId,
        queryIds[0],
        "1",
        "2026-10-25T02:59:59.999Z",
        "completed",
        "true",
        "",
        'Pregunta inicial,\npara 5.º: "raíces"',
        'La raíz ordena las partes,\ny conserva "el sentido".',
        "false",
        "false",
      ],
      [
        "teacher-legacy",
        conversationId,
        queryIds[1],
        "2",
        "2026-10-25T03:00:00.000Z",
        "failed",
        "false",
        "provider_failed",
        "¿Y para primaria?",
        'Respuesta parcial,\ncon "cierre".',
        "false",
        "true",
      ],
      [
        "teacher-legacy",
        conversationId,
        queryIds[2],
        "3",
        "2026-10-25T18:00:00.000Z",
        "in_progress",
        "false",
        "",
        "=SUM(1,1)",
        "Prefijo durable",
        "false",
        "false",
      ],
    ]);
    expect(csvRows.slice(1).map((row) => JSON.parse(row[10]))).toEqual([
      {
        fields: oldProfile.fields,
        responsePreferenceIds: oldProfile.responsePreferenceIds,
      },
      {
        fields: matchingProfile.fields,
        responsePreferenceIds: matchingProfile.responsePreferenceIds,
      },
      {
        fields: matchingProfile.fields,
        responsePreferenceIds: matchingProfile.responsePreferenceIds,
      },
    ]);
    expect(harness.published[0].bytes.byteLength).toBe(result.bytes);
    expect(result.bytes).toBe(Buffer.byteLength(harness.published[0].csv, "utf8"));
    expect(csvRows.every((row) => row.length === 13)).toBe(true);
    expect(harness.published[0].csv).not.toContain("profile-config-9");
    expect(harness.published[0].csv).not.toContain("claude-sonnet");
    expect(harness.published[0].csv).not.toContain("hiddenAt");
    expect(harness.indexRequests).toHaveLength(3);
    expect(harness.indexRequests[0].input.ExclusiveStartKey).toBeUndefined();
    expect(harness.indexRequests[1].input.ExclusiveStartKey).toEqual(
      indexPages[0].LastEvaluatedKey,
    );
    expect(harness.indexRequests[2].input.ExclusiveStartKey).toEqual(
      indexPages[1].LastEvaluatedKey,
    );
    expect(
      harness.indexRequests.every((command) => command.input.IndexName === recordsIndexName),
    ).toBe(true);
    const dateValues = Object.values(
      harness.indexRequests[0].input.ExpressionAttributeValues ?? {},
    ).filter((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value));
    expect(dateValues).toContain("2026-10-25T03:00:00.000Z");
    expect(dateValues).toContain("2026-10-25T18:00:30.000Z");
    expect(harness.database.get(`CONV#${conversationId}`, "META").hiddenAt).toBe(
      "2026-10-25T18:00:10.000Z",
    );
    expect(harness.database.get(`CONV#${conversationId}`, "TURN#00000003").cursor).toBe(2);
    expect(
      harness.commands.some((command) =>
        [PutCommand, UpdateCommand, DeleteCommand, TransactWriteCommand].some(
          (WriteCommand) => command instanceof WriteCommand,
        ),
      ),
    ).toBe(false);
  });

  it("returns empty without publishing when candidates do not match all filters", async () => {
    const turn = makeTurn(conversationId, "teacher-legacy", 1, {
      status: "completed",
      createdAt: "2026-10-25T12:00:00.000Z",
    });
    const harness = makeWorkerHarness({
      records: [
        makeMeta(conversationId, "teacher-legacy", 1),
        turn,
        makeTextChunk(turn, "user", 0, "Pregunta completa"),
        makeTextChunk(turn, "assistant", 0, "Respuesta completa"),
      ],
      indexPages: [{ Items: [makeIndexRow(turn)] }],
    });

    const result = await harness.worker.run({
      botId,
      actorSub,
      exportId,
      filters: { ...filters, status: "failed" },
    });

    expect(result).toEqual({ status: "empty" });
    expect(harness.publishCsv).not.toHaveBeenCalled();
  });

  it("excludes a matching configured test account and marks it when included", async () => {
    const turn = makeTurn(testConversationId, "team-test-sub", 1, {
      status: "failed",
      phase: "failed",
      failure: { code: "provider_failed" },
      createdAt: "2026-10-25T12:00:00.000Z",
    });
    const records = [
      makeMeta(testConversationId, "team-test-sub", 1),
      turn,
      makeTextChunk(turn, "user", 0, "Consulta del equipo"),
      makeTextChunk(turn, "assistant", 0, "Respuesta del equipo"),
    ];
    const matchingFilters = {
      from: "2026-10-25",
      to: "2026-10-25",
      status: "failed",
      levelId: "primario",
      subject: "ciencias, naturales",
    };
    const excluded = makeWorkerHarness({
      records,
      indexPages: [{ Items: [makeIndexRow(turn)] }],
    });

    const excludedResult = await excluded.worker.run({
      botId,
      actorSub,
      exportId,
      filters: { ...matchingFilters, excludeTests: true },
    });

    expect(excludedResult).toEqual({ status: "empty" });
    expect(excluded.publishCsv).not.toHaveBeenCalled();

    const included = makeWorkerHarness({
      records,
      indexPages: [{ Items: [makeIndexRow(turn)] }],
    });
    const includedResult = await included.worker.run({
      botId,
      actorSub,
      exportId,
      filters: { ...matchingFilters, excludeTests: false },
    });

    expect(includedResult).toMatchObject({ status: "ready", conversationCount: 1, rowCount: 1 });
    expect(included.published[0].csv).toContain(
      "team-test-sub,650e8400-e29b-41d4-a716-446655440001,",
    );
    const includedRow = parseCsv(included.published[0].csv)[1];
    expect(includedRow.slice(-2)).toEqual(["true", "true"]);
  });

  it("does not extend a visible thread when a new turn is admitted after its META snapshot", async () => {
    const visibleConversationId = "850e8400-e29b-41d4-a716-446655440003";
    const first = makeTurn(visibleConversationId, "teacher-legacy", 1, {
      status: "completed",
      createdAt: "2026-10-25T17:59:00.000Z",
      profileSnapshot: oldProfile,
    });
    const meta = makeMeta(visibleConversationId, "teacher-legacy", 1, {
      createdAt: "2026-10-25T17:59:00.000Z",
      updatedAt: "2026-10-25T17:59:30.000Z",
      lastQueryId: first.queryId,
      closed: false,
    });
    const records = [
      meta,
      first,
      makeTextChunk(first, "user", 0, "Consulta ya admitida"),
      makeTextChunk(first, "assistant", 0, "Respuesta original"),
    ];
    const nextTurn = makeTurn(visibleConversationId, "teacher-legacy", 2, {
      status: "in_progress",
      phase: "admitted",
      createdAt: "2026-10-25T18:00:35.000Z",
    });
    const harness = makeWorkerHarness({
      records,
      indexPages: [{ Items: [makeIndexRow(first)] }],
      afterRead({ item, database, kind }) {
        if (kind !== "meta" || item.pk !== `CONV#${visibleConversationId}`) return;
        const changedMeta = database.get(item.pk, "META");
        changedMeta.lastOrdinal = 2;
        changedMeta.lastQueryId = nextTurn.queryId;
        changedMeta.activeQueryId = nextTurn.queryId;
        changedMeta.activeOwnerAttemptId = nextTurn.ownerAttemptId;
        changedMeta.updatedAt = nextTurn.createdAt;
        database.set(changedMeta);
        database.set(nextTurn);
        database.set(makeTextChunk(nextTurn, "user", 0, "Admitida después del corte"));
      },
    });

    const result = await harness.worker.run({ botId, actorSub, exportId, filters: {} });

    expect(result).toMatchObject({ status: "ready", conversationCount: 1, rowCount: 1 });
    expect(harness.published[0].csv).toContain("Consulta ya admitida");
    expect(harness.published[0].csv).not.toContain("Admitida después del corte");
    expect(harness.published[0].csv).not.toContain(nextTurn.queryId);
    expect(harness.database.get(`CONV#${visibleConversationId}`, "META").lastOrdinal).toBe(2);
  });

  it.each([
    ["a conversation read error", { failConversationRead: true }],
    ["a missing manifest fragment", { omitAnswerFragment: true }],
  ])("does not publish a ready file after %s", async (_label, failure) => {
    const turn = makeTurn(conversationId, "teacher-legacy", 1, {
      status: "failed",
      phase: "failed",
      failure: { code: "provider_failed" },
      createdAt: "2026-10-25T12:00:00.000Z",
    });
    const records = [
      makeMeta(conversationId, "teacher-legacy", 1),
      turn,
      makeTextChunk(turn, "user", 0, "Consulta completa"),
      makeTextChunk(turn, "assistant", 0, "Prefijo parcial"),
    ];
    const harness = makeWorkerHarness({
      records: failure.omitAnswerFragment
        ? records.filter((item) => item.sk !== `${turn.sk}#${turn.queryId}#ASSISTANT#00000000`)
        : records,
      failConversationRead: failure.failConversationRead,
      indexPages: [{ Items: [makeIndexRow(turn)] }],
    });

    await expect(
      harness.worker.run({
        botId,
        actorSub,
        exportId,
        filters: { status: "failed", excludeTests: true },
      }),
    ).rejects.toThrow();
    expect(harness.published).toHaveLength(0);
  });
});
