import { describe, expect, it } from "vitest";
import type { IdbModelNode } from "../src/core/contract-definition";
import { foreignKeyIndexes } from "../src/core/foreign-key-indexes";
import { validateIdbContractDefinition } from "../src/core/validate-definition";

describe("foreignKeyIndexes", () => {
  it("retains the needed index and validates its field despite a declared name collision", () => {
    const model: IdbModelNode = {
      modelName: "Post",
      storeName: "posts",
      key: "id",
      autoIncrement: false,
      fields: [
        { name: "id", codecId: "idb/string@1", nullable: false, list: false },
        { name: "authorId", codecId: "idb/bool@1", nullable: false, list: false },
      ],
      indexes: [{ name: "authorId", keyPath: "id", unique: true }],
      relations: [
        { name: "author", to: "User", cardinality: "N:1", localFields: ["authorId"], targetFields: ["id"] },
        { name: "editor", to: "User", cardinality: "N:1", localFields: ["authorId"], targetFields: ["id"] },
      ],
    };

    expect(foreignKeyIndexes(model)).toEqual([{ name: "authorId", keyPath: "authorId", unique: false }]);
    expect(validateIdbContractDefinition({ enums: [], models: [model] })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "IDB_INVALID_INDEX", at: ["models", "Post", "indexes", "authorId"] }),
        expect.objectContaining({ code: "IDB_INVALID_INDEX_KEY_TYPE", at: ["models", "Post", "fields", "authorId"] }),
      ])
    );
  });
});
