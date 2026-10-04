import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { describe, expect, it, vi } from "vitest";
import { defineContract } from "../src/exports/contract-ts";
import { interpretPslDocumentToIdbContract } from "../src/exports/contract-psl";
import idbFamilyPack from "../src/exports/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";

describe("contract authoring adapters", () => {
  it("preserves the supported-type diagnostic and scalar order", () => {
    const { document, sources } = parse(
      `model Sample {
        id String @id
        value Unknown
      }`,
      "test.prisma"
    );
    const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
    const result = interpretPslDocumentToIdbContract(symbolTable, "test.prisma");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.diagnostics).toEqual([
      expect.objectContaining({
        code: "IDB_UNSUPPORTED_FIELD_TYPE",
        message:
          'Field "Sample.value" has unsupported type "Unknown". Supported types: String, Int, Float, Boolean, DateTime, BigInt, Decimal, Json, Bytes.',
      }),
    ]);
  });

  it("preserves the dropped-relation warning in both authoring formats", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      defineContract(
        {
          family: idbFamilyPack,
          target: idbTargetPack,
          models: {
            User: { store: "user", key: "id", fields: { id: "String" }, exclude: true },
            Post: {
              store: "post",
              key: "id",
              fields: { id: "String", userId: "String" },
              relations: {
                user: { to: "User", cardinality: "N:1", on: { local: ["userId"], target: ["id"] } },
              },
            },
          },
        },
        { projection: "client" }
      );
      const { document, sources } = parse(
        `model User {
          id String @id
          posts Post[]
          @@idb.exclude
        }
        model Post {
          id String @id
          userId String
          user User @relation(fields: [userId], references: [id])
        }`,
        "test.prisma"
      );
      const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
      const result = interpretPslDocumentToIdbContract(symbolTable, "test.prisma", { projection: "client" });
      expect(result.ok).toBe(true);
      const warning =
        '[prisma-idb] Dropped relation "Post.user" from the client contract: target model "User" is excluded. The relation\'s scalar fields are kept.';
      expect(warnSpy.mock.calls).toEqual([[warning], [warning]]);
    } finally {
      warnSpy.mockRestore();
    }
  });

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
