import { type DataTypeSupport, TIMESTAMP_NOW_GENERATOR_ID } from "@prisma/orm-framework/components/authoring";
import type { DataTypeId } from "@prisma/orm-framework/components/codec";
import {
  type BindingResolution,
  type GeneratorFunctionBinding,
  type GeneratorFunctionContribution,
  type GeneratorFunctionRegistry,
  type MutationDefaultGeneratorDescriptor,
  assembleGeneratorFunctions,
  createGeneratorHelpers,
  singleGeneratorBinding,
} from "@prisma/orm-framework/components/components";
import { CUID_VERSION, NANOID_SIZE, UUID_VERSIONS } from "@prisma/orm-framework/ids";
import {
  type ArgType,
  type AttributeCtx,
  type DataTypeValueOptions,
  type FuncCallSig,
  dataTypeValue,
  leafDiagnostic,
  optional,
  refineArg,
} from "@prisma/orm-framework/psl-parser";
import type { ExecutionMutationDefaultValue } from "@prisma/orm-framework/contract/types";
import type { IdbMutationDefaultGeneratorId } from "@prisma-idb/target-idb/pack";
import { notOk, ok } from "@prisma/orm-framework/utils/result";
import type { IdbGeneratorNode } from "./contract-definition";
import idbTarget from "@prisma-idb/target-idb/pack";
import { idbScalarTypes } from "./psl-scalars";

/*
 * The functions `@onCreate(fn())` and `@onUpdate(fn())` call, bound to the IDB
 * codecs they fill. Ported from upstream's SQL family
 * (`@prisma/orm-family-sql`, `generator-functions.ts`): the same names,
 * arguments, generators and refusal messages, so one schema means the same thing
 * in the browser and on a SQL sync server. IndexedDB has no column lengths, so
 * no binding refuses a field as too short.
 */

const STRING_CODEC = idbScalarTypes.String.output.codecId;
const DATE_CODEC = idbScalarTypes.DateTime.output.codecId;

const NANOID_DEFAULT_SIZE = 21;

function refused(message: string): BindingResolution {
  return { ok: false, message };
}

function generated(id: string, params?: Readonly<Record<string, unknown>>): BindingResolution {
  return {
    ok: true,
    generator: params === undefined ? { kind: "generator", id } : { kind: "generator", id, params },
  };
}

const uuidBinding: GeneratorFunctionBinding = {
  codecIds: [STRING_CODEC],
  generatorIds: ["uuidv4", "uuidv7"],
  resolve: ({ args }) => {
    const version = args["version"];
    if (version === undefined || version === UUID_VERSIONS.v4) return generated("uuidv4");
    if (version === UUID_VERSIONS.v7) return generated("uuidv7");
    return refused(`uuid: version must be ${UUID_VERSIONS.v4} or ${UUID_VERSIONS.v7}, got ${String(version)}`);
  },
  printArguments: (generator) => {
    if (generator.id === "uuidv4") return { args: {}, text: "" };
    if (generator.id === "uuidv7") return { args: { version: UUID_VERSIONS.v7 }, text: String(UUID_VERSIONS.v7) };
    return undefined;
  },
};

const cuidBinding: GeneratorFunctionBinding = {
  codecIds: [STRING_CODEC],
  generatorIds: ["cuid2"],
  resolve: ({ args }) => {
    const version = args["version"];
    return version === CUID_VERSION
      ? generated("cuid2")
      : refused(`cuid: version must be ${CUID_VERSION}, got ${String(version)}`);
  },
  printArguments: (generator) =>
    generator.id === "cuid2" ? { args: { version: CUID_VERSION }, text: String(CUID_VERSION) } : undefined,
};

function isNanoidSize(size: unknown): size is number {
  return typeof size === "number" && Number.isInteger(size) && size >= NANOID_SIZE.min && size <= NANOID_SIZE.max;
}

const nanoidBinding: GeneratorFunctionBinding = {
  codecIds: [STRING_CODEC],
  generatorIds: ["nanoid"],
  resolve: ({ args }) => {
    const explicit = args["size"];
    if (explicit !== undefined && !isNanoidSize(explicit)) {
      return refused(`nanoid: size must be between ${NANOID_SIZE.min} and ${NANOID_SIZE.max}, got ${String(explicit)}`);
    }
    return explicit === undefined ? generated("nanoid") : generated("nanoid", { size: explicit });
  },
  printArguments: (generator) => {
    if (generator.id !== "nanoid") return undefined;
    const size = generator.params?.["size"];
    return typeof size === "number" ? { args: { size }, text: String(size) } : { args: {}, text: "" };
  },
};

/** The completion suggestions of an argument that takes one of `values`, which its label lists. */
function listed(values: readonly number[]): DataTypeValueOptions {
  return { suggestions: values.map(String), labelIsUnion: true };
}

/**
 * One value of the integer data type, as a number, refused at the argument with
 * the function's message when `refusal` returns one.
 */
function checkedInteger<Allowed extends number>(
  integer: DataTypeId,
  dataTypes: DataTypeSupport,
  allowed: DataTypeValueOptions,
  refusal: (value: number, written: string) => string | undefined
): ArgType<Allowed, AttributeCtx> {
  return refineArg(dataTypeValue(integer, dataTypes, allowed), ({ value }, arg, ctx) => {
    const stored = Number(value.value);
    const message = refusal(stored, String(value.value));
    return message === undefined
      ? ok(stored as Allowed)
      : notOk([leafDiagnostic(ctx, arg, message, "PSL_INVALID_GENERATOR_ARGUMENT")]);
  });
}

/**
 * The integer data type that reads a generator function's arguments, as in
 * `uuid(7)`. It is fixed rather than looked up in the data types a signature is
 * built against, because `createGeneratorHelpers` builds each signature against
 * an empty set only to read its argument names.
 */
const INTEGER: DataTypeId = (() => {
  const integer = idbTarget.dataTypes.find((dataType) => dataType.id === "idb/int32");
  if (integer === undefined) throw new Error('The IDB target does not register the "idb/int32" data type.');
  return integer.id;
})();

function uuidSignature(dataTypes: DataTypeSupport) {
  const versions = [UUID_VERSIONS.v4, UUID_VERSIONS.v7] as const;
  return {
    documentation: "Generates a UUID when a value is not supplied.",
    positional: [
      {
        key: "version",
        type: optional(
          checkedInteger<(typeof versions)[number]>(INTEGER, dataTypes, listed(versions), (version, written) =>
            versions.some((allowed) => allowed === version)
              ? undefined
              : `uuid: version must be ${UUID_VERSIONS.v4} or ${UUID_VERSIONS.v7}, got ${written}`
          )
        ),
        documentation: `The UUID version: \`${UUID_VERSIONS.v4}\` or \`${UUID_VERSIONS.v7}\`. Defaults to \`${UUID_VERSIONS.v4}\`.`,
      },
    ],
  } as const satisfies FuncCallSig;
}

function cuidSignature(dataTypes: DataTypeSupport) {
  return {
    documentation: "Generates a CUID2 identifier when a value is not supplied.",
    positional: [
      {
        key: "version",
        type: checkedInteger<typeof CUID_VERSION>(INTEGER, dataTypes, listed([CUID_VERSION]), (version, written) =>
          version === CUID_VERSION ? undefined : `cuid: version must be ${CUID_VERSION}, got ${written}`
        ),
        documentation: `The CUID version. Only \`${CUID_VERSION}\` is supported.`,
      },
    ],
  } as const satisfies FuncCallSig;
}

function nanoidSignature(dataTypes: DataTypeSupport) {
  return {
    documentation: "Generates a Nano ID when a value is not supplied.",
    positional: [
      {
        key: "size",
        type: optional(
          checkedInteger<number>(
            INTEGER,
            dataTypes,
            { label: `integer from ${NANOID_SIZE.min} to ${NANOID_SIZE.max}`, suggestions: [] },
            (size, written) =>
              isNanoidSize(size)
                ? undefined
                : `nanoid: size must be between ${NANOID_SIZE.min} and ${NANOID_SIZE.max}, got ${written}`
          )
        ),
        documentation: `The identifier length, from \`${NANOID_SIZE.min}\` through \`${NANOID_SIZE.max}\`. Defaults to ${NANOID_DEFAULT_SIZE}.`,
      },
    ],
  } as const satisfies FuncCallSig;
}

/** The generator functions IDB declares, with their bindings to the IDB codecs. */
export const idbGeneratorFunctions = [
  {
    name: "now",
    signature: { documentation: "Writes the current time, as a JavaScript Date." } satisfies FuncCallSig,
    bindings: [singleGeneratorBinding({ codecIds: [DATE_CODEC], generatorId: TIMESTAMP_NOW_GENERATOR_ID })],
  },
  { name: "uuid", signature: uuidSignature, bindings: [uuidBinding] },
  { name: "cuid", signature: cuidSignature, bindings: [cuidBinding] },
  {
    name: "ulid",
    signature: { documentation: "Generates a ULID when a value is not supplied." } satisfies FuncCallSig,
    bindings: [singleGeneratorBinding({ codecIds: [STRING_CODEC], generatorId: "ulid" })],
  },
  { name: "nanoid", signature: nanoidSignature, bindings: [nanoidBinding] },
  {
    name: "ksuid",
    signature: { documentation: "Generates a KSUID when a value is not supplied." } satisfies FuncCallSig,
    bindings: [singleGeneratorBinding({ codecIds: [STRING_CODEC], generatorId: "ksuid" })],
  },
] as const satisfies readonly GeneratorFunctionContribution[];

/** The generators IDB's functions produce. The client runs each of them. */
export const idbGeneratorDescriptors: readonly MutationDefaultGeneratorDescriptor[] = [
  ...new Set(idbGeneratorFunctions.flatMap(({ bindings }) => bindings.flatMap(({ generatorIds }) => generatorIds))),
].map((id) => ({ id }));

/** The registry `@onCreate(fn())` and `@onUpdate(fn())` resolve through. */
export const idbGeneratorFunctionRegistry: GeneratorFunctionRegistry = assembleGeneratorFunctions([
  {
    id: "idb",
    generatorFunctions: idbGeneratorFunctions,
    controlMutationDefaults: { generatorDescriptors: idbGeneratorDescriptors },
  },
]);

/**
 * The TypeScript counterparts of the generator functions, as upstream's
 * `defineContract` callback receives them: `gen.uuid(7)` is the call
 * `@onCreate(uuid(7))` writes in PSL. Each call resolves through the same
 * registry when the contract is built.
 */
export const gen = createGeneratorHelpers([{ generatorFunctions: idbGeneratorFunctions }]);

/**
 * The definition node of a generator a generator function resolved to. Every id
 * IDB's functions produce is an {@link IdbMutationDefaultGeneratorId}: the
 * registry refuses a binding whose generator no IDB descriptor registers.
 */
export function idbGeneratorNode(generator: ExecutionMutationDefaultValue): IdbGeneratorNode {
  const id = generator.id as IdbMutationDefaultGeneratorId;
  return generator.params === undefined ? { id } : { id, params: { ...generator.params } };
}
