import * as vm from "node:vm";

/**
 * Sandboxed edge-function runner (node:vm).
 *
 * Contract: the function body receives `input` and returns a value (or a
 * Promise of one). The sandbox exposes ONLY: a captured `console`, the
 * context's own standard intrinsics (JSON, Math, Date, ...), and `input`
 * (JSON-round-tripped through the boundary so its prototypes are
 * context-owned). No require, no process, no Buffer, no fetch, no timers,
 * no filesystem, and no host-reachable values.
 *
 * Honest limits (see also PARITY.md / SECURITY.md): node:vm is a
 * guardrail, not a proven security boundary — determined code can in
 * principle escape a vm context. The function is invoked INSIDE the vm
 * context so CPU-bound infinite loops are stopped by the vm timeout;
 * async hangs are cut by an outer race, except for pathological
 * microtask-starvation loops (`while (true) { await Promise.resolve(); }`)
 * which can still starve the host event loop. Production hardening
 * (worker threads with resource limits, or isolated-vm) is a documented
 * follow-up. Functions run with the caller's org scope and cannot reach
 * other tenants' data: they receive only `input`.
 */

export interface FunctionRunResult {
  logs: string[];
  output: unknown;
}

const MAX_LOGS = 100;
const MAX_LOG_LENGTH = 2000;

export async function runFunctionCode(
  code: string,
  input: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<FunctionRunResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const logs: string[] = [];
  const pushLog = (...args: unknown[]) => {
    if (logs.length >= MAX_LOGS) return;
    const line = args
      .map((a) => (typeof a === "string" ? a : safeStringify(a)))
      .join(" ")
      .slice(0, MAX_LOG_LENGTH);
    logs.push(line);
  };

  // The sandbox object MUST have a null prototype: a plain `{}` sandbox
  // leaks the host Object.prototype through the contextified global's
  // property lookup (`globalThis.toString.constructor` reaches the host
  // Function), which defeats codeGeneration restrictions. With a
  // null-prototype sandbox, intrinsics still resolve (they are own
  // properties of the realm global) but every prototype chain stays
  // inside the context. Verified by the escape tests in functions.test.ts.
  const sandbox: Record<string, unknown> = Object.assign(Object.create(null), {
    __fn: undefined,
    __input: undefined,
    __inputJson: safeStringify(input ?? null),
    __promise: undefined,
    __pushLog: pushLog,
  });
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    name: "edge-function",
  });

  // Set up `console` from a closure over the host log bridge, then remove
  // the bridge from the global scope: user code must never reach a host
  // function (any host reachable value is a vm-escape vector via
  // `.constructor`). Intrinsics (Object, JSON, Math, ...) are deliberately
  // NOT shadowed here: the context provides its own, which respect the
  // codeGeneration restriction. Input crosses the boundary as JSON text
  // and is parsed INSIDE the context so its prototypes are context-owned.
  new vm.Script(
    "{ const push = __pushLog; globalThis.console = { error: (...a) => push(...a), log: (...a) => push(...a), warn: (...a) => push(...a) }; } delete globalThis.__pushLog;",
    { filename: "setup.js" },
  ).runInContext(context, { timeout: timeoutMs });

  // The user code becomes the body of a strict-mode async function
  // receiving `input`. Strict mode makes bare `this` undefined (a plain
  // arrow would inherit the script-level global `this`, another escape
  // path). `return` at top level is the function's result.
  const wrapped = `(async function (input) { "use strict";\n${code}\n})`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: "function.js" });
  } catch (err) {
    throw new Error(`Function failed to parse: ${(err as Error).message}`);
  }

  try {
    sandbox.__fn = script.runInContext(context, { timeout: timeoutMs });
  } catch (err) {
    throw new Error(`Function failed to load: ${(err as Error).message}`);
  }
  if (typeof sandbox.__fn !== "function") {
    throw new Error("Function did not evaluate to a callable");
  }

  // Invoke INSIDE the context so the vm CPU timeout applies to the
  // synchronous portion (a bare `while (true) {}` would otherwise block
  // the host event loop forever and defeat the outer race below).
  // __inputJson is deleted before user code runs.
  let promise: Promise<unknown>;
  try {
    const invoke = new vm.Script(
      "__input = JSON.parse(__inputJson); delete globalThis.__inputJson; __promise = __fn(__input);",
      { filename: "invoke.js" },
    );
    invoke.runInContext(context, { timeout: timeoutMs });
    promise = sandbox.__promise as Promise<unknown>;
  } catch (err) {
    throw new Error(`Function failed: ${(err as Error).message ?? String(err)}`);
  }

  let result: unknown;
  let timer: NodeJS.Timeout | undefined;
  try {
    result = await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Function timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    throw new Error(`Function failed: ${message}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // Serialize through JSON so no exotic host-reachable objects leak out.
  return { logs, output: JSON.parse(safeStringify(result)) as unknown };
}

function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "function" || typeof v === "symbol" || typeof v === "undefined") return undefined;
      return v;
    }) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}
