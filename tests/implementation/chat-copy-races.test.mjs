import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ current: null }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect: () => hooks.current.useEffect(),
    useRef: (initialValue) => hooks.current.useRef(initialValue),
    useState: (initialValue) => hooks.current.useState(initialValue),
  };
});

import { ChatScreen } from "../../web/ChatScreen.tsx";

afterEach(() => {
  hooks.current = null;
  vi.clearAllMocks();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createDriver(initialProps) {
  let props = initialProps;
  const slots = [];
  let cursor = 0;
  let dirty = true;
  let output;

  const runtime = {
    useState(initialValue) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initialValue === "function" ? initialValue() : initialValue };
        slot.set = (nextValue) => {
          slot.value = typeof nextValue === "function" ? nextValue(slot.value) : nextValue;
          dirty = true;
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].set];
    },
    useRef(initialValue) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initialValue };
      return slots[index];
    },
    useEffect() {
      cursor += 1;
    },
  };

  function render() {
    cursor = 0;
    dirty = false;
    hooks.current = runtime;
    try {
      output = ChatScreen(props);
    } finally {
      hooks.current = null;
    }
  }

  return {
    get output() {
      return output;
    },
    setProps(nextProps) {
      props = nextProps;
      dirty = true;
    },
    render,
    async flush() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Promise.resolve();
        if (dirty) render();
        await new Promise((resolve) => setImmediate(resolve));
        if (!dirty) return;
      }
      throw new Error("ChatScreen did not settle");
    },
  };
}

function walk(node, result = []) {
  if (!node || typeof node !== "object") return result;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, result));
    return result;
  }
  result.push(node);
  walk(node.props?.children, result);
  return result;
}

function findNode(root, predicate) {
  return walk(root).find(predicate);
}

function textContent(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (!node || typeof node !== "object") return "";
  return textContent(node.props?.children);
}

function button(driver, name) {
  const match = findNode(
    driver.output,
    (node) =>
      node.type === "button" && (node.props["aria-label"] === name || node.props.children === name),
  );
  expect(match).toBeDefined();
  return match;
}

function answerBlocks(driver) {
  return walk(driver.output).filter((node) => node.props?.className === "chat-answer-block");
}

function alerts(block) {
  return walk(block).filter((node) => node.props?.role === "alert");
}

function props(state, onCopy = vi.fn(), onSubmit = vi.fn(), onReset = vi.fn()) {
  return {
    state,
    onCopy,
    onSubmit,
    onReset,
    onSignOut: vi.fn(),
    onRetryProfile: vi.fn(),
  };
}

describe("copy feedback follows its answer and operation", () => {
  it("keeps a pending answer's failure with it after submitting a follow-up", async () => {
    const answer = "Respuesta A\ncon acentos: acción, ñ.";
    const copy = deferred();
    const onCopy = vi.fn(() => copy.promise);
    const onSubmit = vi.fn();
    const driver = createDriver(
      props(
        {
          profileStatus: "complete",
          queryStatus: "completed",
          question: "Pregunta A",
          answer,
        },
        onCopy,
        onSubmit,
      ),
    );
    driver.render();
    await driver.flush();

    button(driver, "Copiar respuesta").props.onClick();
    expect(onCopy).toHaveBeenCalledWith(answer);

    const textarea = findNode(driver.output, (node) => node.type === "textarea");
    textarea.props.onChange({ currentTarget: { value: "Pregunta B" } });
    await driver.flush();
    findNode(driver.output, (node) => node.type === "form").props.onSubmit({
      preventDefault() {},
    });
    expect(onSubmit).toHaveBeenCalledWith("Pregunta B");

    driver.setProps(
      props(
        {
          profileStatus: "complete",
          queryStatus: "streaming",
          question: "Pregunta B",
          answer: "Prefijo B",
          previousTurns: [{ question: "Pregunta A", answer, status: "completed" }],
        },
        onCopy,
        onSubmit,
      ),
    );
    await driver.flush();
    copy.reject(new Error("clipboard denied"));
    await driver.flush();

    const blocks = answerBlocks(driver);
    expect(blocks).toHaveLength(2);
    expect(alerts(blocks[0])).toHaveLength(1);
    expect(textContent(alerts(blocks[0])[0])).toBe(
      "No pudimos copiar la respuesta. Podés seleccionar el texto y copiarlo.",
    );
    expect(alerts(blocks[1])).toHaveLength(0);
  });

  it("keeps a pending partial answer's failure with it after submitting a follow-up", async () => {
    const answer = "Prefijo parcial A";
    const copy = deferred();
    const onCopy = vi.fn(() => copy.promise);
    const onSubmit = vi.fn();
    const driver = createDriver(
      props(
        {
          profileStatus: "complete",
          queryStatus: "failed",
          question: "Pregunta A",
          answer,
          canContinue: true,
        },
        onCopy,
        onSubmit,
      ),
    );
    driver.render();
    await driver.flush();

    button(driver, "Copiar texto parcial").props.onClick();
    expect(onCopy).toHaveBeenCalledWith(answer);

    const textarea = findNode(driver.output, (node) => node.type === "textarea");
    textarea.props.onChange({ currentTarget: { value: "Pregunta B" } });
    await driver.flush();
    findNode(driver.output, (node) => node.type === "form").props.onSubmit({
      preventDefault() {},
    });
    expect(onSubmit).toHaveBeenCalledWith("Pregunta B");

    driver.setProps(
      props(
        {
          profileStatus: "complete",
          queryStatus: "streaming",
          question: "Pregunta B",
          answer: "Prefijo B",
          previousTurns: [{ question: "Pregunta A", answer, status: "failed" }],
        },
        onCopy,
        onSubmit,
      ),
    );
    await driver.flush();
    copy.reject(new Error("clipboard denied"));
    await driver.flush();

    const blocks = answerBlocks(driver);
    expect(blocks).toHaveLength(2);
    expect(textContent(blocks[0])).toContain("Respuesta incompleta");
    expect(walk(blocks[0]).filter((node) => node.type === "button")).toHaveLength(0);
    expect(alerts(blocks[0])).toHaveLength(1);
    expect(textContent(alerts(blocks[0])[0])).toBe(
      "No pudimos copiar la respuesta. Podés seleccionar el texto y copiarlo.",
    );
    expect(alerts(blocks[1])).toHaveLength(0);
  });

  it("ignores a pending failure after reset when a new conversation has the same answer text", async () => {
    const answer = "Respuesta repetida";
    const copy = deferred();
    const onCopy = vi.fn(() => copy.promise);
    const onReset = vi.fn();
    const driver = createDriver(
      props(
        {
          profileStatus: "complete",
          queryStatus: "completed",
          question: "Pregunta anterior",
          answer,
        },
        onCopy,
        vi.fn(),
        onReset,
      ),
    );
    driver.render();
    await driver.flush();

    button(driver, "Copiar respuesta").props.onClick();
    button(driver, "Volver al inicio").props.onClick();
    await driver.flush();
    expect(onReset).toHaveBeenCalledOnce();

    driver.setProps(
      props({ profileStatus: "complete", queryStatus: "idle" }, onCopy, vi.fn(), onReset),
    );
    await driver.flush();
    driver.setProps(
      props(
        {
          profileStatus: "complete",
          queryStatus: "completed",
          question: "Pregunta nueva",
          answer,
        },
        onCopy,
        vi.fn(),
        onReset,
      ),
    );
    await driver.flush();

    copy.reject(new Error("old clipboard denied"));
    await driver.flush();
    expect(alerts(answerBlocks(driver)[0])).toHaveLength(0);
  });

  it("keeps the current answer's rejection when an older copy succeeds with identical text", async () => {
    const answer = "Texto idéntico";
    const previousCopy = deferred();
    const currentCopy = deferred();
    const onCopy = vi
      .fn()
      .mockReturnValueOnce(previousCopy.promise)
      .mockReturnValueOnce(currentCopy.promise);
    const driver = createDriver(
      props(
        {
          profileStatus: "complete",
          queryStatus: "completed",
          question: "Pregunta B",
          answer,
          previousTurns: [{ question: "Pregunta A", answer, status: "completed" }],
        },
        onCopy,
      ),
    );
    driver.render();
    await driver.flush();

    button(driver, "Copiar respuesta anterior 1").props.onClick();
    button(driver, "Copiar respuesta").props.onClick();
    expect(onCopy.mock.calls).toEqual([[answer], [answer]]);

    currentCopy.reject(new Error("current clipboard denied"));
    await driver.flush();
    let blocks = answerBlocks(driver);
    expect(alerts(blocks[0])).toHaveLength(0);
    expect(alerts(blocks[1])).toHaveLength(1);

    previousCopy.resolve();
    await driver.flush();
    blocks = answerBlocks(driver);
    expect(alerts(blocks[0])).toHaveLength(0);
    expect(alerts(blocks[1])).toHaveLength(1);
  });

  it("ignores an older result when two copies of the same answer settle out of order", async () => {
    const answer = "Misma respuesta";
    const olderSuccess = deferred();
    const newerFailure = deferred();
    const olderFailure = deferred();
    const newerSuccess = deferred();
    const onCopy = vi
      .fn()
      .mockReturnValueOnce(olderFailure.promise)
      .mockReturnValueOnce(newerSuccess.promise)
      .mockReturnValueOnce(olderSuccess.promise)
      .mockReturnValueOnce(newerFailure.promise);
    const driver = createDriver(
      props(
        {
          profileStatus: "complete",
          queryStatus: "completed",
          question: "Pregunta actual",
          answer,
        },
        onCopy,
      ),
    );
    driver.render();
    await driver.flush();

    button(driver, "Copiar respuesta").props.onClick();
    button(driver, "Copiar respuesta").props.onClick();
    newerSuccess.resolve();
    await driver.flush();
    olderFailure.reject(new Error("older copy denied"));
    await driver.flush();
    expect(alerts(answerBlocks(driver)[0])).toHaveLength(0);

    button(driver, "Copiar respuesta").props.onClick();
    button(driver, "Copiar respuesta").props.onClick();
    newerFailure.reject(new Error("newer copy denied"));
    await driver.flush();
    expect(alerts(answerBlocks(driver)[0])).toHaveLength(1);
    olderSuccess.resolve();
    await driver.flush();
    expect(alerts(answerBlocks(driver)[0])).toHaveLength(1);
    expect(onCopy.mock.calls).toEqual([[answer], [answer], [answer], [answer]]);
  });

  it("clears an answer's error after a later copy succeeds and preserves the exact text", async () => {
    const answer = "\nÁrbol, acción y niño.\n";
    const onCopy = vi
      .fn()
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined);
    const driver = createDriver(
      props(
        {
          profileStatus: "complete",
          queryStatus: "completed",
          question: "Prepará el texto",
          answer,
        },
        onCopy,
      ),
    );
    driver.render();
    await driver.flush();

    button(driver, "Copiar respuesta").props.onClick();
    await driver.flush();
    expect(alerts(answerBlocks(driver)[0])).toHaveLength(1);

    button(driver, "Copiar respuesta").props.onClick();
    await driver.flush();
    expect(alerts(answerBlocks(driver)[0])).toHaveLength(0);
    expect(onCopy.mock.calls).toEqual([[answer], [answer]]);
  });
});
