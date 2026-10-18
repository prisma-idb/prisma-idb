import { ContractValidationError } from "@prisma/orm-framework/contract/contract-validation-error";
import type { ContractField } from "@prisma/orm-framework/contract/types";
import { UNBOUND_DOMAIN_NAMESPACE_ID } from "@prisma/orm-framework/contract/types";
import { describe, expect, it } from "vitest";
import { buildRecordShape } from "../src/core/record-shape";
import { validateContract } from "../src/core/validate";
import { createRawIdbContract } from "./_raw-contract";

describe("validateContract", () => {
  it.each(["Model", "Value object"])("rejects a union field in a %s", (owner) => {
    const contract = createRawIdbContract(
      { items: { keyPath: "id" } },
      {
        Item: {
          fields: { id: { nullable: false, type: { kind: "scalar", codecId: "idb/string@1" } } },
          relations: {},
          storage: { storeName: "items" },
        },
      }
    );
    const namespace = {
      ...contract.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]!,
      valueObjects: { Item: { fields: {} as Record<string, ContractField> } },
    };
    const schema = { ...contract, domain: { namespaces: { [UNBOUND_DOMAIN_NAMESPACE_ID]: namespace } } };
    const fields = owner === "Model" ? namespace.models["Item"]!.fields : namespace.valueObjects.Item.fields;
    fields["choice"] = {
      nullable: false,
      type: { kind: "union", members: [{ kind: "scalar", codecId: "idb/string@1" }] },
    };
    expect(() => validateContract(schema)).toThrow(ContractValidationError);
    expect(() => validateContract(schema)).toThrow(
      `${owner} "Item" field "choice" uses a union type, which prisma-idb does not support`
    );
  });
  it("rejects union fields when building stored record metadata", () => {
    expect(() =>
      buildRecordShape(
        "Item",
        {
          choice: {
            nullable: false,
            type: { kind: "union", members: [{ kind: "scalar", codecId: "idb/string@1" }] },
          },
        },
        {}
      )
    ).toThrow('Model "Item" field "choice" uses a union type, which prisma-idb does not support');
  });
});

it.each([{ keyPath: "" }, { keyPath: [] }, { keyPath: ["id", "id"] }, { keyPath: ["id", ""] }])(
  "rejects malformed raw store keys with the shared key-path rule: $keyPath",
  ({ keyPath }) => {
    expect(() => validateContract(createRawIdbContract({ items: { keyPath } }))).toThrow(
      /Store "items" is missing a required keyPath/
    );
  }
);

it("accepts a raw contract with a well-formed store key", () => {
  const contract = createRawIdbContract({ items: { keyPath: "id" } });
  expect(validateContract(contract)).toBe(contract);
});
