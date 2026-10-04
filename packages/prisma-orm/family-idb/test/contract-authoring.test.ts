import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { describe, expect, it } from "vitest";
import { defineContract } from "../src/exports/contract-ts";
import { interpretPslDocumentToIdbContract } from "../src/exports/contract-psl";
import idbFamilyPack from "../src/exports/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";

describe("contract authoring adapters", () => {
  it("preserves scalar codecs and literal defaults in both authoring formats", () => {
    const tsContract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        Sample: {
          store: "sample",
          key: "id",
          fields: {
            id: "String",
            count: "Int",
            rating: "Float",
            enabled: "Boolean",
            createdAt: "DateTime",
            large: "BigInt",
            price: "Decimal",
            metadata: "Json",
            payload: "Bytes",
          },
          fieldDefaults: { id: "sample", count: 3, rating: 1.5, enabled: true, price: 2.5 },
        },
      },
    });
    const { document, sources } = parse(
      `model Sample {
        id        String   @id @default("sample")
        count     Int      @default(3)
        rating    Float    @default(1.5)
        enabled   Boolean  @default(true)
        createdAt DateTime
        large     BigInt
        price     Decimal  @default(2.5)
        metadata  Json
        payload   Bytes
      }`,
      "test.prisma"
    );
    const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
    const pslResult = interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
    expect(pslResult.ok).toBe(true);
    if (!pslResult.ok) return;

    for (const contract of [tsContract, pslResult.value]) {
      const model = domainModelsAtDefaultNamespace(contract.domain)["Sample"]!;
      expect(model.fields).toEqual({
        id: { nullable: false, type: { kind: "scalar", codecId: "idb/string@1" } },
        count: { nullable: false, type: { kind: "scalar", codecId: "idb/int32@1" } },
        rating: { nullable: false, type: { kind: "scalar", codecId: "idb/double@1" } },
        enabled: { nullable: false, type: { kind: "scalar", codecId: "idb/bool@1" } },
        createdAt: { nullable: false, type: { kind: "scalar", codecId: "idb/date@1" } },
        large: { nullable: false, type: { kind: "scalar", codecId: "idb/bigint@1" } },
        price: { nullable: false, type: { kind: "scalar", codecId: "idb/decimal@1" } },
        metadata: { nullable: false, type: { kind: "scalar", codecId: "idb/json@1" } },
        payload: { nullable: false, type: { kind: "scalar", codecId: "idb/bytes@1" } },
      });
      expect(model.storage).toEqual({
        storeName: "sample",
        keyPath: "id",
        fieldDefaults: { id: "sample", count: 3, rating: 1.5, enabled: true, price: 2.5 },
      });
    }
    expect(pslResult.value.storage).toEqual(tsContract.storage);
    expect(pslResult.value.profileHash).toBe(tsContract.profileHash);
  });
});
