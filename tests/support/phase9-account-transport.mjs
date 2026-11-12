import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function storageKey(tableName, key) {
  return `${tableName}\u0000${key.pk}\u0000${key.sk}`;
}

function splitAssignments(value) {
  return value.split(/,(?![^()]*\))/).map((part) => part.trim());
}

function resolvePath(path, names) {
  return path
    .trim()
    .split(".")
    .map((segment) => names[segment] || segment);
}

function getPath(item, path) {
  return path.reduce((value, segment) => value?.[segment], item);
}

function resolveOperand(expression, item, names, values) {
  const token = expression.trim();
  if (Object.hasOwn(values, token)) return clone(values[token]);
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
  return clone(getPath(item, resolvePath(token, names)));
}

function resolveValueExpression(expression, item, names, values) {
  const valueExpression = expression.trim();
  const ifMissing = /^if_not_exists\(([^,]+),\s*([^)]+)\)(?:\s*([+-])\s*(.+))?$/i.exec(
    valueExpression,
  );
  if (ifMissing) {
    const existing = getPath(item, resolvePath(ifMissing[1], names));
    const base =
      existing === undefined ? resolveOperand(ifMissing[2], item, names, values) : existing;
    if (!ifMissing[3]) return clone(base);
    const operand = resolveOperand(ifMissing[4], item, names, values);
    return ifMissing[3] === "+" ? base + operand : base - operand;
  }

  const arithmetic = /^(.+?)\s*([+-])\s*(.+)$/.exec(valueExpression);
  if (arithmetic) {
    const left = resolveOperand(arithmetic[1], item, names, values);
    const right = resolveOperand(arithmetic[3], item, names, values);
    return arithmetic[2] === "+" ? left + right : left - right;
  }
  return resolveOperand(valueExpression, item, names, values);
}

function setPath(item, path, value) {
  const segments = path;
  let target = item;
  for (const segment of segments.slice(0, -1)) {
    if (!target[segment] || typeof target[segment] !== "object") target[segment] = {};
    target = target[segment];
  }
  target[segments.at(-1)] = clone(value);
}

function removePath(item, path) {
  const segments = path;
  let target = item;
  for (const segment of segments.slice(0, -1)) {
    target = target?.[segment];
    if (!target || typeof target !== "object") return;
  }
  delete target[segments.at(-1)];
}

function applyUpdate(items, input) {
  const key = storageKey(input.TableName, input.Key);
  const item = clone(items.get(key) || input.Key);
  const names = input.ExpressionAttributeNames || {};
  const values = input.ExpressionAttributeValues || {};
  const clauses = input.UpdateExpression.matchAll(
    /(?:^|\s)(SET|REMOVE)\s+([\s\S]*?)(?=\s+(?:SET|REMOVE)\s+|$)/g,
  );

  for (const [, operation, expression] of clauses) {
    if (operation === "SET") {
      for (const assignment of splitAssignments(expression)) {
        const separator = assignment.indexOf("=");
        const path = resolvePath(assignment.slice(0, separator), names);
        const valueExpression = assignment.slice(separator + 1).trim();
        setPath(item, path, resolveValueExpression(valueExpression, item, names, values));
      }
    } else {
      for (const attribute of splitAssignments(expression)) {
        removePath(item, resolvePath(attribute, names));
      }
    }
  }

  items.set(key, item);
}

function applyTransaction(items, input) {
  for (const operation of input.TransactItems || []) {
    if (operation.Put) {
      const { TableName, Item } = operation.Put;
      items.set(storageKey(TableName, Item), clone(Item));
    } else if (operation.Update) {
      applyUpdate(items, operation.Update);
    } else if (operation.Delete) {
      const { TableName, Key } = operation.Delete;
      items.delete(storageKey(TableName, Key));
    } else {
      throw new Error("Unsupported action in the phase 9 account transport.");
    }
  }
}

/**
 * Applies successful SDK writes for the phase 9 happy-path journey. It deliberately does not
 * interpret DynamoDB conditions or decide whether a transaction is allowed; the store acceptance
 * tests inspect those real adapter commands directly.
 */
export function createPhase9AccountTransport() {
  const items = new Map();
  const commands = [];

  const documentClient = {
    async send(command) {
      commands.push(command);
      if (command instanceof GetCommand) {
        const item = items.get(storageKey(command.input.TableName, command.input.Key));
        return item ? { Item: clone(item) } : {};
      }
      if (command instanceof UpdateCommand) {
        applyUpdate(items, command.input);
        return {};
      }
      if (command instanceof TransactWriteCommand) {
        applyTransaction(items, command.input);
        return {};
      }
      throw new Error(`Unsupported phase 9 account command: ${command.constructor.name}`);
    },
  };

  return {
    documentClient,
    commands,
    getItem(tableName, key) {
      return clone(items.get(storageKey(tableName, key)));
    },
    items() {
      return [...items.values()].map(clone);
    },
    setItem(tableName, item) {
      items.set(storageKey(tableName, item), clone(item));
    },
  };
}
