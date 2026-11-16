import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  ExecutionAlreadyExists,
  ExecutionDoesNotExist,
  StartExecutionCommand,
  DescribeExecutionCommand,
  type SFNClient,
} from "@aws-sdk/client-sfn";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isDeepStrictEqual } from "node:util";
import type { RecordsExportExecution } from "./records-export-administration.js";
import { parseRecordsExportInput } from "./records-export-contract.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorName(error: unknown): string | undefined {
  return isObject(error) && typeof error.name === "string" ? error.name : undefined;
}

function executionArnForName(stateMachineArn: string, name: string): string {
  const match = /^arn:([^:]+):states:([^:]+):([0-9]{12}):stateMachine:([A-Za-z0-9_-]+)$/.exec(
    stateMachineArn,
  );
  if (!match || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
    throw new TypeError("The configured records state machine or execution name is invalid.");
  }
  const [, partition, region, accountId, stateMachineName] = match;
  return `arn:${partition}:states:${region}:${accountId}:execution:${stateMachineName}:${name}`;
}

function confirmedAbsence(error: unknown): boolean {
  if (!isObject(error)) return false;
  const metadata = error.$metadata;
  const statusCode = isObject(metadata) ? metadata.httpStatusCode : undefined;
  return statusCode === 404 || errorName(error) === "NoSuchKey" || errorName(error) === "NotFound";
}

/** Build a Standard workflow boundary whose names and canonical inputs are idempotent. */
export function createRecordsExportExecution({
  sfnClient,
  stateMachineArn,
}: {
  sfnClient: SFNClient;
  stateMachineArn: string;
}): RecordsExportExecution {
  async function get(input: { name: string }) {
    const executionArn = executionArnForName(stateMachineArn, input.name);
    try {
      const value = await sfnClient.send(new DescribeExecutionCommand({ executionArn }));
      if (
        value.executionArn !== executionArn ||
        value.stateMachineArn !== stateMachineArn ||
        value.name !== input.name ||
        typeof value.input !== "string" ||
        typeof value.status !== "string"
      ) {
        throw Object.assign(new Error("Invalid records execution description."), {
          code: "RECORDS_UNAVAILABLE",
        });
      }
      return {
        executionArn,
        stateMachineArn,
        name: input.name,
        input: value.input,
        ...(typeof value.output === "string" ? { output: value.output } : {}),
        status: value.status,
        ...(value.startDate ? { startDate: value.startDate } : {}),
        ...(value.stopDate ? { stopDate: value.stopDate } : {}),
      };
    } catch (error) {
      if (error instanceof ExecutionDoesNotExist || errorName(error) === "ExecutionDoesNotExist") {
        return null;
      }
      throw error;
    }
  }

  return {
    async start(input) {
      const serializedInput = JSON.stringify(input.input);
      const expectedExecutionArn = executionArnForName(stateMachineArn, input.name);
      try {
        const result = await sfnClient.send(
          new StartExecutionCommand({
            stateMachineArn,
            name: input.name,
            input: serializedInput,
          }),
        );
        if (result.executionArn !== expectedExecutionArn) {
          throw Object.assign(new Error("Records execution receipt was incomplete."), {
            code: "EXPORT_UNCONFIRMED",
          });
        }
        return { executionArn: result.executionArn };
      } catch (error) {
        const existing = await get({ name: input.name });
        if (!existing?.executionArn) {
          throw Object.assign(new Error("Records execution start is unconfirmed."), {
            code: "EXPORT_UNCONFIRMED",
          });
        }
        const existingInput = parseRecordsExportInput(existing.input);
        if (existingInput === null) {
          throw Object.assign(new Error("Records execution input is unavailable."), {
            code: "RECORDS_UNAVAILABLE",
          });
        }
        if (!isDeepStrictEqual(existingInput, input.input)) {
          throw Object.assign(new Error("Export identifier is already bound to other filters."), {
            code: "CONFLICT",
          });
        }
        if (
          error instanceof ExecutionAlreadyExists ||
          errorName(error) === "ExecutionAlreadyExists" ||
          errorName(error) === "ExecutionLimitExceeded" ||
          errorName(error) === "ThrottlingException" ||
          errorName(error) === "ServiceUnavailable"
        ) {
          return { executionArn: existing.executionArn };
        }
        return { executionArn: existing.executionArn };
      }
    },
    get,
  };
}

/** Build the exact-object HEAD and short-lived attachment GET boundaries for exports. */
export function createRecordsExportObjects({
  s3Client,
  now = Date.now,
}: {
  s3Client: S3Client;
  now?: () => number;
}) {
  return {
    async head(input: { bucket: string; key: string }) {
      try {
        const result = await s3Client.send(
          new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
        );
        if (typeof result.ETag !== "string" || typeof result.ContentLength !== "number") {
          throw new Error("S3 returned incomplete export receipt metadata.");
        }
        return { eTag: result.ETag, contentLength: result.ContentLength };
      } catch (error) {
        if (confirmedAbsence(error)) return null;
        throw error;
      }
    },

    async signGet(input: {
      bucket: string;
      key: string;
      fileName: string;
      expiresInSeconds: number;
    }): Promise<string> {
      if (
        !Number.isSafeInteger(input.expiresInSeconds) ||
        input.expiresInSeconds < 1 ||
        input.expiresInSeconds > 120 ||
        !/^[A-Za-z0-9_-]+\.csv$/.test(input.fileName)
      ) {
        throw new TypeError("The export download constraints are invalid.");
      }
      const credentials = await s3Client.config.credentials();
      const credentialExpiry = credentials.expiration?.getTime() ?? Number.POSITIVE_INFINITY;
      const expiresInSeconds = Math.min(
        input.expiresInSeconds,
        Math.floor((credentialExpiry - now()) / 1000),
      );
      if (expiresInSeconds < 1) throw new Error("No valid export download lifetime remains.");
      const disposition = `attachment; filename="${input.fileName}"`;
      return getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          ResponseContentDisposition: disposition,
          ResponseCacheControl: "no-store",
        }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}
