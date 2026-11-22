import { type DataTypeSupport, TIMESTAMP_NOW_GENERATOR_ID } from "@prisma/orm-framework/components/authoring";
import type { DataTypeId } from "@prisma/orm-framework/components/codec";
import {
  type BindingResolution,
  type GeneratorFunctionBinding,
  type GeneratorFunctionContribution,
  type GeneratorFunctionRegistry,
  type MutationDefaultGeneratorDescriptor,
  assembleGeneratorFunctions,
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
import { notOk, ok } from "@prisma/orm-framework/utils/result";
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
const INT_CODEC = idbScalarTypes.Int.output.codecId;

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

/** The integer data type that reads a generator function's arguments. */
function integerOf(dataTypes: DataTypeSupport): DataTypeId {
  const integer = dataTypes.dataTypeOfCodec(INT_CODEC);
  if (integer === undefined) throw new Error(`The IDB data types do not include the integer codec "${INT_CODEC}".`);
  return integer;
}

function uuidSignature(dataTypes: DataTypeSupport) {
  const versions = [UUID_VERSIONS.v4, UUID_VERSIONS.v7] as const;
  return {
    documentation: "Generates a UUID when a value is not supplied.",
    positional: [
      {
        key: "version",
        type: optional(
          checkedInteger<(typeof versions)[number]>(
            integerOf(dataTypes),
            dataTypes,
            listed(versions),
            (version, written) =>
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
        type: checkedInteger<typeof CUID_VERSION>(
          integerOf(dataTypes),
          dataTypes,
          listed([CUID_VERSION]),
          (version, written) =>
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
            integerOf(dataTypes),
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
