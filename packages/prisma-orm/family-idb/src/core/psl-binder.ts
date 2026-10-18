import { assembleAuthoringContributions } from "@prisma/orm-framework/components/control";
import type { ContractSourceDiagnostic } from "@prisma/orm-framework/config/config-types";
import {
  EMPTY_DATA_TYPES,
  bool,
  createBinder,
  fieldAttribute,
  funcCall,
  identifier,
  interpretAttribute,
  leafDiagnostic,
  list,
  mapArg,
  mapPslDiagnostics,
  modelAttribute,
  nodePslSpan,
  numLiteral,
  oneOf,
  optional,
  str,
} from "@prisma/orm-framework/psl-parser";
import type {
  ArgType,
  AttributeCtx,
  AttributeSpec,
  AttributeSpecNamespace,
  FieldAttributeCtx,
  FieldSymbol,
  ModelAttributeCtx,
  ModelSymbol,
  PslSpan,
  ResolvedAttribute,
  SymbolTable,
} from "@prisma/orm-framework/psl-parser";
import { FunctionCallAst, PslSources, SourceFile, printSyntax } from "@prisma/orm-framework/psl-parser/syntax";
import type {
  FieldAttributeAst,
  ModelAttributeAst,
  ExpressionAst,
  SyntaxNode,
} from "@prisma/orm-framework/psl-parser/syntax";
import { notOk, ok } from "@prisma/orm-framework/utils/result";

/*
 * The only module that imports the PSL binder and attribute-spec APIs. They are
 * release-candidate APIs in `@prisma/orm-framework`, so keeping them behind this
 * file limits the churn of a later upstream change to one place. The interpreter
 * reads typed attribute values from {@link IdbAttributeBinder} and never touches
 * attribute arguments itself.
 *
 * Follows upstream's SQL family: `@prisma/orm-family-sql/contract-psl`
 * (`sqlAttributeSpecs`, `interpretModelAttribute`, `interpretFieldAttribute`).
 */

/** The attribute namespace family-idb owns. A foreign PSL parser rejects it, see `stripIdbExcludeAttributes`. */
export const IDB_EXCLUDE_ATTR = "idb.exclude";

// ── Argument types ─────────────────────────────────────────────────────────────

/**
 * The value of an `@default(...)` argument as written: its source text, plus the
 * form the interpreter needs to pick a default.
 *
 * The interpreter, not the spec, decides which functions and literals a field
 * type admits. That keeps the `IDB_*` diagnostics (unknown function, bad
 * argument, wrong literal type) in one place, shared with the TypeScript DSL.
 */
export interface IdbDefaultValue {
  /** The argument's source text, trimmed. Quoted in diagnostics and used as the stored value of an enum default. */
  readonly raw: string;
  readonly form:
    | { readonly kind: "string"; readonly value: string }
    | { readonly kind: "boolean"; readonly value: boolean }
    | { readonly kind: "number"; readonly value: number }
    | { readonly kind: "identifier"; readonly name: string }
    | { readonly kind: "list" }
    | { readonly kind: "call"; readonly name: string; readonly args: readonly string[] };
}

/** The source text of one syntax node without its surrounding whitespace. */
function sourceText(node: SyntaxNode): string {
  return printSyntax(node).trim();
}

/**
 * An argument that is a call to any function, for example `uuid(7)`. Upstream's
 * `funcCall` is bound to one function name, so it could not report an unknown
 * function by name. This arm only checks the argument is a call; the form is
 * read in {@link defaultValueArg}.
 */
function anyFunctionCall(): ArgType<unknown, AttributeCtx> {
  return {
    ...funcCall("function", { documentation: "A default function." }),
    label: "function call",
    claims: (arg: ExpressionAst) => FunctionCallAst.cast(arg.syntax) !== undefined,
    parse: (arg, ctx) => {
      const call = FunctionCallAst.cast(arg.syntax);
      const name = call?.name();
      if (call === undefined || name === undefined)
        return notOk([leafDiagnostic(ctx, arg, "Expected a function call")]);
      return ok({ fn: sourceText(name.syntax), span: nodePslSpan(arg.syntax, ctx.sources), args: {} });
    },
  };
}

/** Reads the name and the argument text of a call that {@link anyFunctionCall} accepted. */
function callForm(arg: ExpressionAst): IdbDefaultValue["form"] {
  const call = FunctionCallAst.cast(arg.syntax)!;
  return {
    kind: "call",
    name: sourceText(call.name()!.syntax),
    args: Array.from(call.args(), (argument) => sourceText(argument.syntax)),
  };
}

/** The `@default(...)` argument: a literal, a bare identifier (an enum member), a list, or a function call. */
function defaultValueArg(): ArgType<IdbDefaultValue, AttributeCtx> {
  return mapArg(
    oneOf(
      mapArg(bool(), (value) => ({ kind: "boolean" as const, value })),
      mapArg(str(), (value) => ({ kind: "string" as const, value })),
      mapArg(numLiteral(), ({ text }) => ({ kind: "number" as const, value: Number(text) })),
      mapArg(identifier(), (name) => ({ kind: "identifier" as const, name })),
      // Scalar-list defaults are not supported; binding them lets the interpreter report that with its own code.
      mapArg(list(oneOf(identifier(), str(), numLiteral(), bool())), () => ({ kind: "list" as const })),
      mapArg(anyFunctionCall(), (_call, arg) => callForm(arg))
    ),
    (form, arg) => ({ raw: sourceText(arg.syntax), form })
  );
}

/**
 * A string literal read as its source text between the quotes, with escape
 * sequences left undecoded. Storage and index names have always been taken
 * verbatim, and decoding them would change the object-store name and the hash
 * for a name such as `"a\nb"`.
 */
function verbatimStr(): ArgType<string, AttributeCtx> {
  return mapArg(str(), (_decoded, arg) => sourceText(arg.syntax).slice(1, -1));
}

/**
 * A named argument that other Prisma targets give meaning (`sort`, `length`,
 * `clustered`, `type`, `map` on a field default, ...). IDB accepts and ignores
 * it, as it always has, so one schema can serve every target.
 */
const portableOnly = {
  type: optional(oneOf(identifier(), numLiteral(), bool(), str())),
  documentation: "Accepted for schema portability; IDB ignores it.",
};

/** The portable arguments of an attribute that declares a key or an index. */
const portableKeyArgs = { map: portableOnly, length: portableOnly, sort: portableOnly, clustered: portableOnly };

// ── Attribute specs ────────────────────────────────────────────────────────────

/*
 * Argument types are as permissive as the interpreter was before, so that every
 * schema it accepted still binds. Names stay plain identifiers (`identifier()`,
 * not `fieldRef()`): the shared definition validator reports an unknown field
 * with its `IDB_*` code and source span, which `fieldRef()` would pre-empt with
 * a generic reference error.
 */

const mapModelSpec = modelAttribute("map", {
  documentation: "Names the object store this model is stored in.",
  positional: [{ key: "name", type: verbatimStr(), documentation: "The object store name." }],
});

const idModelSpec = modelAttribute("id", {
  documentation: "Declares a compound primary key for this model.",
  positional: [{ key: "fields", type: list(identifier()), documentation: "The ordered primary-key fields." }],
  named: { ...portableKeyArgs, name: portableOnly },
});

const uniqueModelSpec = modelAttribute("unique", {
  documentation: "Creates a unique index over these fields.",
  positional: [{ key: "fields", type: list(identifier()), documentation: "The ordered indexed fields." }],
  named: {
    ...portableKeyArgs,
    name: { type: optional(verbatimStr()), documentation: "The index name." },
    map: { type: optional(verbatimStr()), documentation: "The index name, when `name` is not given." },
  },
});

const indexModelSpec = modelAttribute("index", {
  documentation: "Creates a non-unique index over these fields.",
  positional: [{ key: "fields", type: list(identifier()), documentation: "The ordered indexed fields." }],
  named: {
    ...portableKeyArgs,
    type: portableOnly,
    name: { type: optional(verbatimStr()), documentation: "The index name." },
    map: { type: optional(verbatimStr()), documentation: "The index name, when `name` is not given." },
  },
});

const excludeModelSpec = modelAttribute(IDB_EXCLUDE_ATTR, {
  documentation: "Leaves this model out of the client contract.",
});

const idFieldSpec = fieldAttribute("id", {
  documentation: "Makes this field the primary key.",
  named: portableKeyArgs,
});

const uniqueFieldSpec = fieldAttribute("unique", {
  documentation: "Creates a unique index over this field.",
  named: portableKeyArgs,
});

const updatedAtFieldSpec = fieldAttribute("updatedAt", {
  documentation: "Sets this field to the current time on every create and update.",
});

const defaultFieldSpec = fieldAttribute("default", {
  documentation: "Supplies a value when the field is omitted from a create.",
  positional: [
    {
      key: "value",
      type: defaultValueArg(),
      documentation: "A literal, an enum member, or one of `now()`, `uuid()`, `cuid()` and `autoincrement()`.",
    },
  ],
  named: { map: portableOnly },
});

const relationFieldSpec = fieldAttribute("relation", {
  documentation: "Defines the foreign key behind this relation field.",
  positional: [
    { key: "name", type: optional(str()), documentation: "The relation name. Accepted for schema portability." },
  ],
  named: {
    name: { type: optional(str()), documentation: "The relation name. Accepted for schema portability." },
    fields: { type: optional(list(identifier())), documentation: "The local foreign-key fields." },
    references: { type: optional(list(identifier())), documentation: "The referenced fields on the other model." },
    map: { type: optional(str()), documentation: "Accepted for schema portability; IDB ignores it." },
    onDelete: { type: optional(identifier()), documentation: "The referential action on delete." },
    onUpdate: { type: optional(identifier()), documentation: "The referential action on update." },
  },
});

const excludeFieldSpec = fieldAttribute(IDB_EXCLUDE_ATTR, {
  documentation: "Leaves this field out of the client contract.",
});

/**
 * Every attribute the IDB interpreter reads, keyed by PSL name. Upstream expects a
 * factory per entry because a spec may depend on the field or model; none of
 * these do. Any attribute not listed here is ignored, as before.
 */
export const idbAttributeSpecs = {
  model: {
    map: () => mapModelSpec,
    id: () => idModelSpec,
    unique: () => uniqueModelSpec,
    index: () => indexModelSpec,
    [IDB_EXCLUDE_ATTR]: () => excludeModelSpec,
  },
  field: {
    id: () => idFieldSpec,
    unique: () => uniqueFieldSpec,
    updatedAt: () => updatedAtFieldSpec,
    default: () => defaultFieldSpec,
    relation: () => relationFieldSpec,
    [IDB_EXCLUDE_ATTR]: () => excludeFieldSpec,
  },
} satisfies AttributeSpecNamespace;

// ── Binding ────────────────────────────────────────────────────────────────────

/** One attribute's typed arguments and the source span of the whole attribute. */
export interface BoundAttribute<Value> {
  readonly value: Value;
  readonly span: PslSpan;
}

/** A `@@index` or `@@unique`, with the explicit name it was given, if any. */
export interface BoundIndex {
  readonly unique: boolean;
  readonly fields: readonly string[];
  readonly name: string | undefined;
  readonly span: PslSpan;
}

/** The attributes of one model that the interpreter reads. */
export interface BoundModelAttributes {
  readonly map: BoundAttribute<{ readonly name: string }> | undefined;
  readonly id: BoundAttribute<{ readonly fields: readonly string[] }> | undefined;
  readonly indexes: readonly BoundIndex[];
  /** True when an attribute failed to bind; its diagnostics are already reported. */
  readonly failed: boolean;
}

/** The arguments of `@relation(...)` that the interpreter reads. */
export interface BoundRelation {
  readonly fields?: readonly string[] | undefined;
  readonly references?: readonly string[] | undefined;
  readonly onDelete?: string | undefined;
  readonly onUpdate?: string | undefined;
}

/** The attributes of one field that the interpreter reads. `id`, `unique` and `updatedAt` carry only their span. */
export interface BoundFieldAttributes {
  readonly id: PslSpan | undefined;
  readonly unique: PslSpan | undefined;
  readonly updatedAt: PslSpan | undefined;
  readonly default: BoundAttribute<IdbDefaultValue> | undefined;
  readonly relation: BoundAttribute<BoundRelation> | undefined;
  /** True when an attribute failed to bind; its diagnostics are already reported. */
  readonly failed: boolean;
}

/** Reads typed attribute values from the models and fields of one parsed schema. */
export interface IdbAttributeBinder {
  /** Binds a model's `@@map`, `@@id`, `@@index` and `@@unique`, reporting failures once. */
  model(model: ModelSymbol): BoundModelAttributes;
  /** Binds a field's `@id`, `@unique`, `@updatedAt`, `@default` and `@relation`, reporting failures once. */
  field(model: ModelSymbol, field: FieldSymbol): BoundFieldAttributes;
  /**
   * Whether `@@idb.exclude` is present. Only the exclusion attribute is bound, and a malformed one is reported,
   * so an excluded model's other attributes go unread.
   */
  isModelExcluded(model: ModelSymbol): boolean;
  /** Whether `@idb.exclude` is present. Checked without binding. */
  isFieldExcluded(field: FieldSymbol): boolean;
}

/** What {@link createIdbAttributeBinder} needs to bind a parsed schema and report problems against it. */
export interface IdbAttributeBinderInput {
  readonly table: SymbolTable;
  readonly sourceId: string;
  /** The parsed sources. Without them, an equivalent registry is rebuilt from the symbol table. */
  readonly sources: PslSources | undefined;
  /** Receives one diagnostic per attribute that fails to bind. */
  readonly diagnostics: ContractSourceDiagnostic[];
}

/**
 * Rebuilds a source registry from the syntax trees behind the symbol table. Spans
 * only need each tree's text, and printing a tree returns its source exactly, so
 * the rebuilt registry yields the spans of the original.
 */
function sourcesFromSymbolTable(table: SymbolTable, sourceId: string): PslSources {
  const roots = new Set<SyntaxNode>();
  for (const namespace of Object.values(table.namespaces)) {
    for (const model of Object.values(namespace.models)) roots.add(model.node.syntax.root());
  }
  return new PslSources([...roots].map((root) => [root, new SourceFile(sourceId, printSyntax(root))] as const));
}

/**
 * Binds the supported attributes of a parsed schema, mirroring how upstream's SQL
 * interpreter binds its own. Bind failures become diagnostics in
 * `input.diagnostics`; the caller skips the model or field that failed.
 */
export function createIdbAttributeBinder(input: IdbAttributeBinderInput): IdbAttributeBinder {
  const { table, sourceId, diagnostics } = input;
  const sources = input.sources ?? sourcesFromSymbolTable(table, sourceId);
  // The binder only supplies context to the specs above. Its own diagnostics
  // (for example unresolved types) are left out: the interpreter reports those
  // problems with `IDB_*` codes already.
  const { binder } = createBinder({
    sources,
    symbolTable: table,
    context: {
      authoringContributions: assembleAuthoringContributions([{ authoring: { attributeSpecs: idbAttributeSpecs } }]),
      dataTypes: EMPTY_DATA_TYPES,
      controlMutationDefaults: { defaultFunctionRegistry: new Map() },
    },
  });
  const base: AttributeCtx = { sources, symbols: table, binder };

  /** Interprets `attribute` against `spec`. A failure is reported and returns `undefined`. */
  function interpret<Value, Ctx extends AttributeCtx, Node extends FieldAttributeAst | ModelAttributeAst>(
    spec: AttributeSpec<Value, Ctx>,
    attribute: ResolvedAttribute<Node>,
    ctx: Ctx
  ): Value | undefined {
    const result = interpretAttribute(attribute.node, spec, ctx);
    if (result.ok) return result.value;
    diagnostics.push(...mapPslDiagnostics(result.failure, sources));
    return undefined;
  }

  const boundModels = new Map<ModelSymbol, BoundModelAttributes>();

  /** Binds one model's attributes. */
  function bindModel(model: ModelSymbol): BoundModelAttributes {
    const cached = boundModels.get(model);
    if (cached !== undefined) return cached;

    const ctx: ModelAttributeCtx = { ...base, selfModel: model };
    let failed = false;
    let map: BoundModelAttributes["map"];
    let id: BoundModelAttributes["id"];
    const indexes: BoundIndex[] = [];

    for (const attribute of model.attributes) {
      const span = attribute.span;
      switch (attribute.name) {
        case "map": {
          const value = interpret(mapModelSpec, attribute, ctx);
          if (value === undefined) failed = true;
          else map ??= { value, span };
          break;
        }
        case "id": {
          const value = interpret(idModelSpec, attribute, ctx);
          if (value === undefined) failed = true;
          else id ??= { value, span };
          break;
        }
        case "index":
        case "unique": {
          const unique = attribute.name === "unique";
          const value = interpret(unique ? uniqueModelSpec : indexModelSpec, attribute, ctx);
          // `map` names the index when `name` is absent, as it did before the spec table.
          if (value === undefined) failed = true;
          else indexes.push({ unique, fields: value.fields, name: value.name ?? value.map, span });
          break;
        }
        case IDB_EXCLUDE_ATTR:
          if (interpret(excludeModelSpec, attribute, ctx) === undefined) failed = true;
          break;
      }
    }
    const bound = { map, id, indexes, failed };
    boundModels.set(model, bound);
    return bound;
  }

  const boundFields = new Map<FieldSymbol, BoundFieldAttributes>();

  /** Binds one field's attributes. The owning model is part of the context upstream's specs receive. */
  function bindField(model: ModelSymbol, field: FieldSymbol): BoundFieldAttributes {
    const cached = boundFields.get(field);
    if (cached !== undefined) return cached;

    const ctx: FieldAttributeCtx = { ...base, selfModel: model, field };
    let failed = false;
    let id: PslSpan | undefined;
    let unique: PslSpan | undefined;
    let updatedAt: PslSpan | undefined;
    let defaultValue: BoundFieldAttributes["default"];
    let relation: BoundFieldAttributes["relation"];

    for (const attribute of field.attributes) {
      const span = attribute.span;
      switch (attribute.name) {
        case "id":
          if (interpret(idFieldSpec, attribute, ctx) === undefined) failed = true;
          else id ??= span;
          break;
        case "unique":
          if (interpret(uniqueFieldSpec, attribute, ctx) === undefined) failed = true;
          else unique ??= span;
          break;
        case "updatedAt":
          if (interpret(updatedAtFieldSpec, attribute, ctx) === undefined) failed = true;
          else updatedAt ??= span;
          break;
        case "default": {
          const value = interpret(defaultFieldSpec, attribute, ctx);
          if (value === undefined) failed = true;
          else defaultValue ??= { value: value.value, span };
          break;
        }
        case "relation": {
          const value = interpret(relationFieldSpec, attribute, ctx);
          if (value === undefined) failed = true;
          else relation ??= { value, span };
          break;
        }
        case IDB_EXCLUDE_ATTR:
          if (interpret(excludeFieldSpec, attribute, ctx) === undefined) failed = true;
          break;
      }
    }
    const bound = { id, unique, updatedAt, default: defaultValue, relation, failed };
    boundFields.set(field, bound);
    return bound;
  }

  return {
    model: bindModel,
    field: bindField,
    isModelExcluded: (model) => {
      const markers = model.attributes.filter(({ name }) => name === IDB_EXCLUDE_ATTR);
      // Validate every marker, not just the first, so a repeated malformed exclusion cannot hide in either projection.
      // The model stays excluded either way: a malformed exclusion fails the contract through its diagnostic.
      for (const marker of markers) interpret(excludeModelSpec, marker, { ...base, selfModel: model });
      return markers.length > 0;
    },
    isFieldExcluded: (field) => field.attributes.some((attribute) => attribute.name === IDB_EXCLUDE_ATTR),
  };
}
