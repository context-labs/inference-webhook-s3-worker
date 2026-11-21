import { describe, expect, it } from "vitest";

import { decode, iterGroup, type GroupObject } from "../examples/typescript/read-results.ts";

const base64 = (array: Float32Array | Uint16Array) => Buffer.from(array.buffer).toString("base64");

describe("read-results decode", () => {
  it("decodes little-endian float32 and float16", () => {
    expect([...decode(base64(new Float32Array([0.5, -2])))]).toEqual([0.5, -2]);
    // 0x3800 = 0.5, 0xc000 = -2, 0x0001 = smallest subnormal, 0x7c00 = Infinity
    expect([...decode(base64(new Uint16Array([0x3800, 0xc000, 0x0001, 0x7c00])), "float16")]).toEqual([0.5, -2, 2 ** -24, Infinity]);
  });

  it("decodes each generation with the embed_dtype of its own request", () => {
    const doc: GroupObject = {
      data: {
        generations: [
          { id: "a", state: "Success", request: { metadata: { custom_ids: ["x"] }, embed_dtype: "float16" }, response: { data: [{ index: 0, embedding: base64(new Uint16Array([0x3c00])) }] } },
          { id: "b", state: "Success", request: { metadata: { custom_ids: ["y"] } }, response: { data: [{ index: 0, embedding: base64(new Float32Array([1])) }] } },
        ],
      },
    };
    expect([...iterGroup(doc)].map(([id, vec]) => [id, [...vec]])).toEqual([["x", [1]], ["y", [1]]]);
  });
});
