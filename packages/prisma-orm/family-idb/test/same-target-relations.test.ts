import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { UNBOUND_DOMAIN_NAMESPACE_ID } from "@prisma/orm-framework/contract/types";
import { describe, expect, it } from "vitest";
import { interpretPslDocumentToIdbContract } from "../src/exports/contract-psl";

function interpret(schema: string) {
  const { document, sources } = parse(schema, "test.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  return interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
}

describe("same-target PSL relations", () => {
  it("preserves a single unnamed self-relation pair", () => {
    const result = interpret(`
      model Person {
        id String @id
        parentId String?
        parent Person? @relation(fields: [parentId], references: [id])
        children Person[]
      }
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]!.models["Person"]!.relations).toMatchObject({
      parent: { on: { localFields: ["parentId"], targetFields: ["id"] } },
      children: { on: { localFields: ["id"], targetFields: ["parentId"] } },
    });
  });

  it.each([
    [
      "foreign keys",
      `parent Person? @relation(fields: [parentId], references: [id])
       mentor Person? @relation(fields: [mentorId], references: [id])
       children Person[]`,
    ],
    [
      "backrelations",
      `parent Person? @relation(fields: [parentId], references: [id])
       children Person[]
       mentees Person[]`,
    ],
  ])("rejects ambiguous unnamed self-relation %s", (_, relations) => {
    const result = interpret(`
      model Person {
        id String @id
        parentId String?
        mentorId String?
        ${relations}
      }
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "IDB_AMBIGUOUS_RELATION" })])
    );
  });

  it.each(["posts Post[]", "posts Post[]\n        editedPosts Post[]", ""])(
    "rejects ambiguous unnamed foreign keys with backrelations %j",
    (backrelations) => {
      const result = interpret(`
      model User {
        id String @id
        ${backrelations}
      }
      model Post {
        id String @id
        authorId String
        editorId String
        author User @relation(fields: [authorId], references: [id])
        editor User @relation(fields: [editorId], references: [id])
      }
    `);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "IDB_AMBIGUOUS_RELATION",
            message: expect.stringMatching(/Post.*author.*editor.*User.*@relation/),
            sourceId: "test.prisma",
            span: expect.any(Object),
          }),
        ])
      );
    }
  );

  it.each(['"PostAuthor"', 'name: "PostAuthor"'])("matches a relation named with %s", (name) => {
    const result = interpret(`
      model User {
        id String @id
        posts Post[] @relation(${name})
        editedPosts Post[] @relation("PostEditor")
      }
      model Post {
        id String @id
        editorId String
        authorId String
        editor User @relation("PostEditor", fields: [editorId], references: [id])
        author User @relation(${name}, fields: [authorId], references: [id])
      }
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.domain.namespaces[UNBOUND_DOMAIN_NAMESPACE_ID]!.models["User"]!.relations).toMatchObject({
      posts: { on: { localFields: ["id"], targetFields: ["authorId"] } },
      editedPosts: { on: { localFields: ["id"], targetFields: ["editorId"] } },
    });
  });

  it("does not fall back to a foreign key with a different relation name", () => {
    const result = interpret(`
      model User {
        id String @id
        posts Post[] @relation("PostAuthor")
      }
      model Post {
        id String @id
        editorId String
        editor User @relation("PostEditor", fields: [editorId], references: [id])
      }
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "IDB_UNRESOLVED_BACKRELATION" })])
    );
  });
});
