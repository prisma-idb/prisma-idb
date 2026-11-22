import type { ControlFamilyDescriptor, ControlStack } from "@prisma/orm-framework/components/control";
import { idbEmission } from "./emission";
import { type IdbControlFamilyInstance, createIdbFamilyInstance } from "./control-instance";
import { idbGeneratorDescriptors, idbGeneratorFunctions } from "./generator-functions";
import { idbAttributeSpecs } from "./psl-binder";
import { idbScalarTypes } from "./psl-scalars";

/**
 * IDB family descriptor — the control-plane entry point for the IDB family.
 *
 * Registered in a Prisma 8 config file under the `family` key:
 * ```ts
 * import idb from '@prisma-idb/family-idb/control';
 * export default defineConfig({ family: idb, ... });
 * ```
 *
 * **Responsibilities:**
 * - Carries the {@link idbEmission} plugin used by `prisma contract emit`
 *   to generate `contract.d.ts`.
 * - Acts as a factory: `create(stack)` returns an {@link IdbControlFamilyInstance}
 *   with domain-action methods consumed by the CLI.
 */
export class IdbFamilyDescriptor implements ControlFamilyDescriptor<"idb", IdbControlFamilyInstance> {
  readonly kind = "family" as const;
  readonly id = "idb";
  readonly familyId = "idb" as const;
  readonly version = "0.0.1";
  readonly emission = idbEmission;
  /** Makes scalar types and attribute signatures discoverable by editor tooling. */
  readonly authoring = { type: idbScalarTypes, attributeSpecs: idbAttributeSpecs };
  /** The functions `@onCreate(fn())` and `@onUpdate(fn())` call, so editor tooling can offer them. */
  readonly generatorFunctions = idbGeneratorFunctions;
  /** The generators those functions produce, each registered once. */
  readonly controlMutationDefaults = {
    defaultFunctionRegistry: new Map(),
    generatorDescriptors: idbGeneratorDescriptors,
  };

  /**
   * Creates an {@link IdbControlFamilyInstance} for the given control stack.
   *
   * The instance is a plain object whose methods implement the CLI domain
   * actions (validateContract, verify, sign, etc.).
   */
  create(stack: ControlStack<"idb", string>): IdbControlFamilyInstance {
    return createIdbFamilyInstance(stack);
  }
}
