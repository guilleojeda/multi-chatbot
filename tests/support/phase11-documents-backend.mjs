export const phase11Now = Date.parse("2026-11-13T15:00:00.000Z");
export const phase11UpdatedAt = new Date(phase11Now).toISOString();
export const phase11BotId = "docentes";
export const phase11AdminClientId = "admin-client";
export const phase11AdminGroup = "multi-chatbot-admin";

export function phase11AdminClaims({
  sub = "admin-sub",
  tokenUse = "access",
  clientId = phase11AdminClientId,
  groups = [phase11AdminGroup],
  exp = Math.floor((phase11Now + 60_000) / 1000),
} = {}) {
  return {
    sub,
    token_use: tokenUse,
    client_id: clientId,
    exp,
    "cognito:groups": groups,
  };
}

export function phase11AdminEvent({
  method,
  path,
  body,
  query = {},
  claims = phase11AdminClaims(),
  token = "validated-admin-token",
} = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const requestContext = { http: { method, path } };
  if (claims !== null) requestContext.authorizer = { jwt: { claims } };
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: new URLSearchParams(query).toString(),
    queryStringParameters: query,
    headers,
    requestContext,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

export function phase11ResponseBody(response) {
  return typeof response.body === "string" ? JSON.parse(response.body) : (response.body ?? {});
}

export function phase11CommandRecorder(send = async () => ({})) {
  const commands = [];
  return {
    commands,
    documentClient: {
      async send(command) {
        commands.push(command);
        return send(command, commands.length - 1);
      },
    },
  };
}

export function phase11Operation({
  operationId = "operation-1",
  documentId = "document-1",
  action = "upload",
  status = "awaiting_upload",
  stage = "upload",
  revision = "revision-1",
  updatedAt = phase11UpdatedAt,
  canRetry = false,
  error,
  ...rest
} = {}) {
  return {
    operationId,
    documentId,
    action,
    status,
    stage,
    revision,
    updatedAt,
    canRetry,
    ...(error ? { error } : {}),
    ...rest,
  };
}
