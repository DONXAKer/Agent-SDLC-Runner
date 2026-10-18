import { resolveOptions } from "../src/options.mjs";
import { test } from "node:test";
import assert from "node:assert";

test("resolveOptions should merge objects correctly", () => {
  const base = {
    a: 1,
    b: 2,
    c: undefined,
    __proto__: { foo: "bar" }
  };
  
  const override = {
    b: 3,
    d: 4,
    c: undefined,
    __proto__: { baz: "qux" }
  };
  
  const result = resolveOptions(base, override);
  
  assert.deepStrictEqual(result, {
    a: 1,
    b: 3,
    c: undefined,
    d: 4,
    __proto__: { baz: "qux" }
  });
});

test("resolveOptions should preserve null, false, zero and empty string", () => {
  const base = {
    a: null,
    b: false,
    c: 0,
    d: ""
  };
  
  const override = {
    a: "new",
    b: true,
    c: 1,
    d: "non-empty"
  };
  
  const result = resolveOptions(base, override);
  
  assert.deepStrictEqual(result, {
    a: "new",
    b: true,
    c: 1,
    d: "non-empty"
  });
});

test("resolveOptions should omit undefined keys absent from base", () => {
  const base = {
    a: 1
  };
  
  const override = {
    b: undefined,
    c: 2
  };
  
  const result = resolveOptions(base, override);
  
  assert.deepStrictEqual(result, {
    a: 1,
    c: 2
  });
});

test("resolveOptions should ignore inherited keys", () => {
  function Base() {}
  Base.prototype.inherited = "should be ignored";
  
  const base = new Base();
  base.own = "should be kept";
  
  const override = {
    inherited: "also ignored",
    own: "updated"
  };
  
  const result = resolveOptions(base, override);
  
  assert.deepStrictEqual(result, {
    own: "updated"
  });
});