import { UNBOUND_DOMAIN_NAMESPACE_ID } from "@prisma/orm-framework/contract/types";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { describe, expect, it } from "vitest";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";

const SCHEMA = `enum Role {
  ADMIN = 1
  USER = "user"
  GUEST = "user"
}

model Account {
  id   String @id
  role Role
}
`;

/** Interprets `SCHEMA`, with or without the parsed sources the provider supplies. */
function diagnostics(withSources: boolean) {
  const { document, sources } = parse(SCHEMA, "schema.prisma");
  const { symbolTable } = buildSymbolTable({
    documents: [document],
    sources,
    defaultNamespaceId: UNBOUND_DOMAIN_NAMESPACE_ID,
  });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma", withSources ? { sources } : undefined);
  if (result.ok) throw new Error("expected enum diagnostics");
  return result.failure.diagnostics;
}

describe("enum member diagnostics", () => {
  it("reports a non-string and a repeated value", () => {
    expect(diagnostics(true).map((d) => d.code)).toEqual(["IDB_ENUM_VALUE_NOT_STRING", "IDB_ENUM_DUPLICATE_VALUE"]);
  });

  it("points at the member when the sources are available", () => {
    const [notString, duplicate] = diagnostics(true);
    expect(notString?.span?.start.line).toBe(2);
    expect(duplicate?.span?.start.line).toBe(4);
  });

  it("points at the enum block when the sources are not available", () => {
    const [notString, duplicate] = diagnostics(false);
    expect(notString?.span?.start.line).toBe(1);
    expect(duplicate?.span?.start.line).toBe(1);
  });
});
