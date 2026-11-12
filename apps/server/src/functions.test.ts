import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runFunctionCode } from "./functions";

describe("edge function sandbox", () => {
  test("returns values, captures logs, supports async code", async () => {
    const r = await runFunctionCode(
      "console.log('hi', input.n); return { out: input.n + 1 };",
      { n: 1 },
      { timeoutMs: 1000 },
    );
    assert.deepEqual(r.output, { out: 2 });
    assert.deepEqual(r.logs, ["hi 1"]);

    const a = await runFunctionCode("return await Promise.resolve(input.x * 2);", { x: 4 }, { timeoutMs: 1000 });
    assert.equal(a.output, 8);
  });

  test("no process, require, Buffer, fetch, or timers", async () => {
    for (const code of [
      "return process.version;",
      "return require('fs');",
      "return Buffer.from('x');",
      "return fetch('https://example.com');",
      "return globalThis.process.version;",
      "return this.constructor.constructor('return process')();",
      "return ({}).constructor.constructor('return process')();",
      "return Function('return process')();",
      "return eval('process');",
      "return globalThis.constructor.constructor('return process')();",
      "return globalThis.__proto__.constructor.constructor('return process')();",
      "return globalThis.toString.constructor('return process')();",
    ]) {
      await assert.rejects(() => runFunctionCode(code, {}, { timeoutMs: 1000 }), /Function failed/);
    }
  });

  test("infinite loops are stopped by the timeout", async () => {
    await assert.rejects(
      () => runFunctionCode("while (true) {}", {}, { timeoutMs: 300 }),
      /timed out|Function failed/,
    );
  });

  test("syntax errors are reported, not thrown raw", async () => {
    await assert.rejects(() => runFunctionCode("return {;", {}, { timeoutMs: 1000 }), /parse/);
  });

  test("JSON, Math, Date work; output is JSON-serializable", async () => {
    const r = await runFunctionCode(
      "return { sum: Math.max(1, 2), when: new Date('2026-01-01').getFullYear(), parsed: JSON.parse('{\"a\":1}') };",
      {},
      { timeoutMs: 1000 },
    );
    assert.deepEqual(r.output, { parsed: { a: 1 }, sum: 2, when: 2026 });
  });
});
