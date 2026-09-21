import type { ControlFamilyDescriptor, ControlStack } from "@prisma/orm-framework/components/control";
import { idbEmission } from "./emission";
import { type IdbControlFamilyInstance, createIdbFamilyInstance } from "./control-instance";

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
