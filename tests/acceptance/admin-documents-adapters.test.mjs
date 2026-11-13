import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

async function loadAdapters() {
  return import("../../api/document-aws-adapters.ts");
}

describe("document AWS adapters", () => {
  it("treats only a confirmed missing S3 object as absence and keeps mutations on the effect client", async () => {
    const { createDocumentObjects } = await loadAdapters();
    const readClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("missing object"), { name: "NotFound" }))
        .mockRejectedValueOnce(Object.assign(new Error("missing bucket"), { name: "NoSuchBucket" }))
        .mockResolvedValueOnce({
          ContentLength: 4,
          ChecksumSHA256: "checksum-base64",
        })
        .mockResolvedValueOnce({ Body: Readable.from([Buffer.from("text")]) }),
    };
    const effectClient = { send: vi.fn(async () => ({ CopyObjectResult: { ETag: "copied" } })) };
    const objects = createDocumentObjects({ s3Client: readClient, effectClient });

    await expect(objects.head({ bucket: "prepared", key: "prepared/a.txt" })).resolves.toBeNull();
    await expect(objects.head({ bucket: "missing", key: "missing/a.txt" })).rejects.toMatchObject({
      name: "NoSuchBucket",
    });
    await expect(objects.head({ bucket: "prepared", key: "prepared/a.txt" })).resolves.toEqual({
      contentLength: 4,
      checksumSHA256: "checksum-base64",
    });
    const body = await objects.get({ bucket: "incoming", key: "incoming/a.txt" });
    expect([
      ...(await (async () => {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        return chunks;
      })()),
    ]).toEqual([Buffer.from("text")]);

    await objects.copy({
      sourceBucket: "incoming",
      sourceKey: "incoming/a b.txt",
      destinationBucket: "prepared",
      destinationKey: "prepared/document-1/revision-1/a b.txt",
    });
    await objects.delete({ bucket: "prepared", key: "prepared/document-1/revision-1/a b.txt" });

    expect(readClient.send).toHaveBeenCalledTimes(4);
    expect(effectClient.send).toHaveBeenCalledTimes(2);
    expect(effectClient.send.mock.calls[0][0].input.CopySource).toBe("incoming/incoming/a%20b.txt");
  });

  it("normalizes Bedrock NOT_FOUND only for the exact requested source URI", async () => {
    const { createDocumentIngestion } = await loadAdapters();
    const sourceUri = "s3://prepared-docentes/prepared/document-1/revision-1/lesson.txt";
    const bedrockClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ ingestionJob: { ingestionJobId: "ingestion-job-1" } })
        .mockResolvedValueOnce({
          ingestionJob: {
            ingestionJobId: "ingestion-job-1",
            status: "COMPLETE",
            statistics: { numberOfDocumentsFailed: 0 },
          },
        })
        .mockResolvedValueOnce({
          documentDetails: [
            {
              knowledgeBaseId: "kb-docentes",
              dataSourceId: "source-docentes",
              identifier: { dataSourceType: "S3", s3: { uri: sourceUri } },
              status: "NOT_FOUND",
            },
          ],
        })
        .mockResolvedValueOnce({
          documentDetails: [
            {
              knowledgeBaseId: "kb-docentes",
              dataSourceId: "source-docentes",
              identifier: { dataSourceType: "S3", s3: { uri: "s3://prepared/other.txt" } },
              status: "NOT_FOUND",
            },
          ],
        }),
    };
    const ingestion = createDocumentIngestion({ bedrockClient });

    await expect(
      ingestion.start({
        knowledgeBaseId: "kb-docentes",
        dataSourceId: "source-docentes",
        clientToken: "a".repeat(64),
        description: "multi-chatbot docentes operation-1",
      }),
    ).resolves.toEqual({ jobId: "ingestion-job-1" });
    await expect(
      ingestion.get({
        knowledgeBaseId: "kb-docentes",
        dataSourceId: "source-docentes",
        jobId: "ingestion-job-1",
      }),
    ).resolves.toMatchObject({
      jobId: "ingestion-job-1",
      status: "COMPLETE",
      statistics: { numberOfDocumentsFailed: 0 },
    });

    await expect(
      ingestion.getDocument({
        knowledgeBaseId: "kb-docentes",
        dataSourceId: "source-docentes",
        sourceUri,
      }),
    ).resolves.toEqual({ status: "ABSENT", sourceUri });
    await expect(
      ingestion.getDocument({
        knowledgeBaseId: "kb-docentes",
        dataSourceId: "source-docentes",
        sourceUri,
      }),
    ).resolves.toBeNull();
    expect(bedrockClient.send.mock.calls[0][0].input).toMatchObject({
      knowledgeBaseId: "kb-docentes",
      dataSourceId: "source-docentes",
      clientToken: "a".repeat(64),
      description: "multi-chatbot docentes operation-1",
    });
    expect(bedrockClient.send.mock.calls[2][0].input.documentIdentifiers).toEqual([
      { dataSourceType: "S3", s3: { uri: sourceUri } },
    ]);
  });

  it("describes the deterministic execution ARN and reconciles ExecutionAlreadyExists by matching canonical input", async () => {
    const { createDocumentExecution } = await loadAdapters();
    const stateMachineArn =
      "arn:aws:states:us-east-1:118903272638:stateMachine:multi-chatbot-dev-documents";
    const name = "doc-docentes-operation-1";
    const executionArn =
      "arn:aws:states:us-east-1:118903272638:execution:multi-chatbot-dev-documents:doc-docentes-operation-1";
    const executionInput = { botId: "docentes", operationId: "operation-1", step: "validate" };
    const alreadyExists = Object.assign(new Error("already exists"), {
      name: "ExecutionAlreadyExists",
    });
    const sfnClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(alreadyExists)
        .mockResolvedValueOnce({
          executionArn,
          status: "RUNNING",
          input: JSON.stringify(executionInput),
        })
        .mockResolvedValueOnce({
          executionArn,
          status: "RUNNING",
          input: JSON.stringify(executionInput),
        }),
    };
    const execution = createDocumentExecution({ sfnClient, stateMachineArn });

    await expect(execution.start({ name, input: executionInput })).resolves.toMatchObject({
      executionArn,
      status: "RUNNING",
    });
    await expect(execution.get({ name })).resolves.toMatchObject({
      executionArn,
      status: "RUNNING",
    });
    expect(sfnClient.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "StartExecutionCommand",
      "DescribeExecutionCommand",
      "DescribeExecutionCommand",
    ]);
    expect(sfnClient.send.mock.calls[1][0].input.executionArn).toBe(executionArn);
    expect(sfnClient.send.mock.calls[0][0].input).toMatchObject({
      stateMachineArn,
      name,
      input: JSON.stringify(executionInput),
    });
  });

  it("returns no execution only for ExecutionDoesNotExist and propagates inconclusive Describe failures", async () => {
    const { createDocumentExecution } = await loadAdapters();
    const stateMachineArn =
      "arn:aws:states:us-east-1:118903272638:stateMachine:multi-chatbot-dev-documents";
    const name = "doc-docentes-operation-2";
    const sfnClient = {
      send: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("not found"), { name: "ExecutionDoesNotExist" }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error("access denied"), { name: "AccessDeniedException" }),
        ),
    };
    const execution = createDocumentExecution({ sfnClient, stateMachineArn });

    await expect(execution.get({ name })).resolves.toBeNull();
    await expect(execution.get({ name })).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(sfnClient.send).toHaveBeenCalledTimes(2);
  });
});
