import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import {
  GetIngestionJobCommand,
  GetKnowledgeBaseDocumentsCommand,
  StartIngestionJobCommand,
  type BedrockAgentClient,
  type DocumentIdentifier,
  type DocumentStatus,
  type IngestionJobStatus,
} from "@aws-sdk/client-bedrock-agent";
import {
  DescribeExecutionCommand,
  ExecutionAlreadyExists,
  ExecutionDoesNotExist,
  StartExecutionCommand,
  type SFNClient,
} from "@aws-sdk/client-sfn";
import type { Readable } from "node:stream";

const MAX_DOCUMENT_BYTES = 50_000_000;
const MAX_POLICY_AGE_MS = 5 * 60_000;
const POLICY_EXPIRY_MARGIN_MS = 2_000;

export type DocumentSource = {
  bucket: string;
  key: string;
  uri: string;
  sizeBytes: number;
  sha256: string;
};

export type DocumentHead = {
  contentLength: number;
  checksumSHA256: string;
};

type DocumentObjectInput = { bucket: string; key: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorName(error: unknown): string | undefined {
  return isObject(error) && typeof error.name === "string" ? error.name : undefined;
}

function isConfirmedS3Absence(error: unknown): boolean {
  if (!isObject(error)) return false;
  if (errorName(error) === "NoSuchBucket") return false;
  const metadata = error.$metadata;
  const statusCode = isObject(metadata) ? metadata.httpStatusCode : undefined;
  return statusCode === 404 || errorName(error) === "NoSuchKey" || errorName(error) === "NotFound";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    Symbol.asyncIterator in value
  );
}

function copySource(bucket: string, key: string): string {
  const encoded = encodeURIComponent(`${bucket}/${key}`);
  return encoded.replaceAll("%2F", "/");
}

/** Build the S3 object boundary used by the document administration and worker. */
export function createDocumentObjects({
  s3Client,
  effectClient = s3Client,
}: {
  s3Client: S3Client;
  effectClient?: S3Client;
}) {
  return {
    async head(input: DocumentObjectInput): Promise<DocumentHead | null> {
      try {
        const result = await s3Client.send(
          new HeadObjectCommand({ Bucket: input.bucket, Key: input.key, ChecksumMode: "ENABLED" }),
        );
        if (typeof result.ContentLength !== "number" || typeof result.ChecksumSHA256 !== "string") {
          throw new Error("S3 returned incomplete document receipt metadata.");
        }
        return {
          contentLength: result.ContentLength,
          checksumSHA256: result.ChecksumSHA256,
        };
      } catch (error) {
        if (isConfirmedS3Absence(error)) return null;
        throw error;
      }
    },

    async get(input: DocumentObjectInput): Promise<Readable | AsyncIterable<Uint8Array>> {
      const result = await s3Client.send(
        new GetObjectCommand({ Bucket: input.bucket, Key: input.key, ChecksumMode: "ENABLED" }),
      );
      if (!isAsyncIterable(result.Body)) {
        throw new Error("S3 returned a document body that cannot be read as a stream.");
      }
      return result.Body;
    },

    async copy(input: {
      sourceBucket: string;
      sourceKey: string;
      destinationBucket: string;
      destinationKey: string;
    }): Promise<{ etag?: string }> {
      const result = await effectClient.send(
        new CopyObjectCommand({
          Bucket: input.destinationBucket,
          Key: input.destinationKey,
          CopySource: copySource(input.sourceBucket, input.sourceKey),
        }),
      );
      return { ...(result.CopyObjectResult?.ETag ? { etag: result.CopyObjectResult.ETag } : {}) };
    },

    async delete(input: DocumentObjectInput): Promise<void> {
      await effectClient.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
    },
  };
}

export type IngestionJob = {
  jobId?: string;
  status?: IngestionJobStatus;
  statistics?: { numberOfDocumentsFailed?: number };
  failureReasons?: string[];
};

function exactS3Identifier(sourceUri: string): DocumentIdentifier {
  return { dataSourceType: "S3", s3: { uri: sourceUri } };
}

const documentStatuses = new Set<DocumentStatus>([
  "STARTING",
  "PENDING",
  "IN_PROGRESS",
  "INDEXED",
  "PARTIALLY_INDEXED",
  "METADATA_PARTIALLY_INDEXED",
  "METADATA_UPDATE_FAILED",
  "FAILED",
  "NOT_FOUND",
  "IGNORED",
  "DELETING",
  "DELETE_IN_PROGRESS",
]);

function isDocumentStatus(value: unknown): value is DocumentStatus {
  return typeof value === "string" && documentStatuses.has(value as DocumentStatus);
}

/** Build the Bedrock Knowledge Base job and exact-source observation boundary. */
export function createDocumentIngestion({ bedrockClient }: { bedrockClient: BedrockAgentClient }) {
  return {
    async start(input: {
      knowledgeBaseId: string;
      dataSourceId: string;
      clientToken: string;
      description: string;
    }): Promise<{ jobId?: string }> {
      const result = await bedrockClient.send(new StartIngestionJobCommand(input));
      const jobId = result.ingestionJob?.ingestionJobId;
      return jobId ? { jobId } : {};
    },

    async get(input: {
      knowledgeBaseId: string;
      dataSourceId: string;
      jobId: string;
    }): Promise<IngestionJob | null> {
      const result = await bedrockClient.send(
        new GetIngestionJobCommand({
          knowledgeBaseId: input.knowledgeBaseId,
          dataSourceId: input.dataSourceId,
          ingestionJobId: input.jobId,
        }),
      );
      const job = result.ingestionJob;
      if (!job) return null;
      return {
        ...(job.ingestionJobId ? { jobId: job.ingestionJobId } : {}),
        ...(job.status ? { status: job.status } : {}),
        ...(job.statistics
          ? { statistics: { numberOfDocumentsFailed: job.statistics.numberOfDocumentsFailed } }
          : {}),
        ...(job.failureReasons ? { failureReasons: job.failureReasons } : {}),
      };
    },

    async getDocument(input: {
      knowledgeBaseId: string;
      dataSourceId: string;
      sourceUri: string;
    }): Promise<{ status: DocumentStatus | "ABSENT"; sourceUri: string } | null> {
      const result = await bedrockClient.send(
        new GetKnowledgeBaseDocumentsCommand({
          knowledgeBaseId: input.knowledgeBaseId,
          dataSourceId: input.dataSourceId,
          documentIdentifiers: [exactS3Identifier(input.sourceUri)],
        }),
      );
      const matches = (result.documentDetails ?? []).filter((detail) => {
        const identifier = detail.identifier;
        return (
          detail.knowledgeBaseId === input.knowledgeBaseId &&
          detail.dataSourceId === input.dataSourceId &&
          identifier?.dataSourceType === "S3" &&
          identifier.s3?.uri === input.sourceUri
        );
      });
      if (matches.length !== 1) return null;
      const status = matches[0]?.status;
      if (!isDocumentStatus(status)) return null;
      return {
        status: status === "NOT_FOUND" ? "ABSENT" : status,
        sourceUri: input.sourceUri,
      };
    },
  };
}

export type DocumentExecutionDescription = {
  executionArn: string;
  status?: string;
  input?: string;
};

function executionArnForName(stateMachineArn: string, name: string): string {
  const match = /^arn:([^:]+):states:([^:]+):([0-9]{12}):stateMachine:([A-Za-z0-9_-]+)$/.exec(
    stateMachineArn,
  );
  if (!match || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
    throw new TypeError("The configured state machine or execution name is invalid.");
  }
  const [, partition, region, accountId, stateMachineName] = match;
  return `arn:${partition}:states:${region}:${accountId}:execution:${stateMachineName}:${name}`;
}

function sameExecutionInput(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(actual)) === JSON.stringify(JSON.parse(expected));
  } catch {
    return actual === expected;
  }
}

/** Build the Step Functions execution boundary for one configured Standard state machine. */
export function createDocumentExecution({
  sfnClient,
  stateMachineArn,
}: {
  sfnClient: SFNClient;
  stateMachineArn: string;
}) {
  async function get(input: { name: string }): Promise<DocumentExecutionDescription | null> {
    const executionArn = executionArnForName(stateMachineArn, input.name);
    try {
      const described = await sfnClient.send(new DescribeExecutionCommand({ executionArn }));
      if (typeof described.input !== "string") {
        throw new Error("Step Functions returned an execution without its canonical input.");
      }
      return {
        executionArn: described.executionArn ?? executionArn,
        ...(described.status ? { status: described.status } : {}),
        input: described.input,
      };
    } catch (error) {
      if (error instanceof ExecutionDoesNotExist || errorName(error) === "ExecutionDoesNotExist") {
        return null;
      }
      throw error;
    }
  }

  return {
    async start(input: { name: string; input: Record<string, unknown> | string }) {
      const serializedInput =
        typeof input.input === "string" ? input.input : JSON.stringify(input.input);
      try {
        const result = await sfnClient.send(
          new StartExecutionCommand({
            stateMachineArn,
            name: input.name,
            input: serializedInput,
          }),
        );
        if (!result.executionArn) throw new Error("Step Functions omitted the execution ARN.");
        return { executionArn: result.executionArn };
      } catch (error) {
        if (
          !(error instanceof ExecutionAlreadyExists) &&
          errorName(error) !== "ExecutionAlreadyExists"
        )
          throw error;
        const existing = await get({ name: input.name });
        if (!existing?.executionArn || !sameExecutionInput(existing.input, serializedInput))
          throw error;
        return existing;
      }
    },

    get,
  };
}

/** Create the real AWS POST policy signer, bounded by both the administrator token and credentials. */
export function createDocumentUploadSigner({
  s3Client,
  now = Date.now,
}: {
  s3Client: S3Client;
  now?: () => number;
}) {
  return {
    async createPost(input: {
      bucket: string;
      key: string;
      name: string;
      sizeBytes: number;
      sha256: string;
      contentType: string;
      expiresAt: number;
    }): Promise<{ url: string; fields: Record<string, string>; expiresAt: number }> {
      if (
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 1 ||
        input.sizeBytes > MAX_DOCUMENT_BYTES ||
        !/^[a-f0-9]{64}$/i.test(input.sha256)
      ) {
        throw new TypeError("Document upload constraints are invalid.");
      }
      const credentials = await s3Client.config.credentials();
      const issuedAt = now();
      const credentialExpiry = credentials.expiration?.getTime() ?? Number.POSITIVE_INFINITY;
      const deadline = Math.min(input.expiresAt, issuedAt + MAX_POLICY_AGE_MS, credentialExpiry);
      const expiresInSeconds = Math.floor((deadline - issuedAt - POLICY_EXPIRY_MARGIN_MS) / 1000);
      if (!Number.isFinite(deadline) || expiresInSeconds < 1) {
        throw new Error("No valid document upload policy lifetime remains.");
      }
      const checksum = Buffer.from(input.sha256, "hex").toString("base64");
      const result = await createPresignedPost(s3Client, {
        Bucket: input.bucket,
        Key: input.key,
        Expires: expiresInSeconds,
        Fields: {
          key: input.key,
          "Content-Type": input.contentType,
          "x-amz-checksum-algorithm": "SHA256",
          "x-amz-checksum-sha256": checksum,
        },
        Conditions: [
          { bucket: input.bucket },
          ["eq", "$key", input.key],
          ["eq", "$Content-Type", input.contentType],
          ["eq", "$x-amz-checksum-algorithm", "SHA256"],
          ["eq", "$x-amz-checksum-sha256", checksum],
          ["content-length-range", input.sizeBytes, input.sizeBytes],
        ],
      });
      const policyField = Object.entries(result.fields).find(
        ([name]) => name.toLowerCase() === "policy",
      )?.[1];
      if (typeof policyField !== "string") throw new Error("The signed upload policy is missing.");
      let policyExpiry: number;
      try {
        const policy: unknown = JSON.parse(Buffer.from(policyField, "base64").toString("utf8"));
        if (!isObject(policy) || typeof policy.expiration !== "string") throw new Error();
        policyExpiry = Date.parse(policy.expiration);
      } catch {
        throw new Error("The signed upload policy has no valid expiration.");
      }
      if (!Number.isFinite(policyExpiry) || policyExpiry <= issuedAt || policyExpiry > deadline) {
        throw new Error("The signed upload policy exceeds its authorized expiration.");
      }
      return { ...result, expiresAt: policyExpiry };
    },
  };
}
