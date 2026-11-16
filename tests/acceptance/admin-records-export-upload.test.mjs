import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it, vi } from "vitest";

let uploadRecordsCsv;

beforeAll(async () => {
  const module = await import("../../api/records-export-uploader.ts");
  uploadRecordsCsv = module.uploadRecordsCsv;
});

function makeClient({ completeError, abortError } = {}) {
  const commands = [];
  const client = {
    config: {
      requestHandler: {},
      requestChecksumCalculation: async () => "NEVER",
    },
    send: vi.fn(async (command) => {
      commands.push(command);
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-id-9mib" };
      if (command instanceof UploadPartCommand) {
        return { ETag: `"part-${command.input.PartNumber}"` };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        if (completeError) throw completeError;
        return { ETag: '"complete-etag"' };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        if (abortError) throw abortError;
        return {};
      }
      throw new Error(`Unexpected S3 command ${command.constructor.name}.`);
    }),
  };
  return { client, commands };
}

async function* nineMiBBody() {
  yield Buffer.alloc(9 * 1024 * 1024, 0x61);
}

function uploadInput(client) {
  return {
    client,
    bucket: "temporary-docentes",
    key: "exports/attempt.csv",
    contentType: "text/csv; charset=utf-8",
    body: nineMiBBody(),
  };
}

function commandsOf(commands, type) {
  return commands.filter((command) => command instanceof type);
}

describe("records CSV multipart cleanup", () => {
  it("keeps the normal 9 MiB multipart result and does not abort success", async () => {
    const { client, commands } = makeClient();

    await expect(uploadRecordsCsv(uploadInput(client))).resolves.toEqual({
      eTag: '"complete-etag"',
    });

    expect(commandsOf(commands, CreateMultipartUploadCommand)).toHaveLength(1);
    expect(commandsOf(commands, UploadPartCommand)).toHaveLength(2);
    expect(commandsOf(commands, CompleteMultipartUploadCommand)).toHaveLength(1);
    expect(commandsOf(commands, AbortMultipartUploadCommand)).toHaveLength(0);
    expect(
      commandsOf(commands, UploadPartCommand).reduce(
        (total, command) => total + command.input.Body.byteLength,
        0,
      ),
    ).toBe(9 * 1024 * 1024);
  });

  it("aborts the exact multipart upload once when completion fails", async () => {
    const completionFailure = new Error("complete multipart failed");
    const { client, commands } = makeClient({ completeError: completionFailure });

    await expect(uploadRecordsCsv(uploadInput(client))).rejects.toBe(completionFailure);

    const aborts = commandsOf(commands, AbortMultipartUploadCommand);
    expect(aborts).toHaveLength(1);
    expect(aborts[0].input).toEqual({
      Bucket: "temporary-docentes",
      Key: "exports/attempt.csv",
      UploadId: "upload-id-9mib",
    });
  });

  it("preserves the upload failure if best-effort abort also fails", async () => {
    const completionFailure = new Error("complete multipart failed");
    const { client, commands } = makeClient({
      completeError: completionFailure,
      abortError: new Error("abort unavailable"),
    });

    await expect(uploadRecordsCsv(uploadInput(client))).rejects.toBe(completionFailure);
    expect(commandsOf(commands, AbortMultipartUploadCommand)).toHaveLength(1);
  });
});
