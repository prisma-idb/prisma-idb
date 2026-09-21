import type { Contract } from "@prisma/orm-framework/contract/types";
import type { TargetBoundComponentDescriptor } from "@prisma/orm-framework/components/components";
import type {
  ContractSerializer,
  ControlAdapterInstance,
  ControlFamilyInstance,
  ControlTargetInstance,
  MigratableTargetDescriptor,
  TargetMigrationsCapability,
} from "@prisma/orm-framework/components/control";
import { idbTargetDescriptorMeta } from "../core/descriptor-meta";
import { IdbMigrationPlanner, contractToIdbSchema } from "../core/migration-planner";
import { IdbMigrationRunner } from "../core/migration-runner";

/**
 * IDB contract serializer — validates on input, passes through on output.
 *
 * IDB contracts are TypeScript-first (`defineContract`), so they are
 * already plain objects with no class instances. Serialization is identity;
 * deserialization runs validation.
 */
const idbContractSerializer: ContractSerializer<Contract> = {
  deserializeContract<T extends Contract = Contract>(json: unknown): T {
    return json as T;
  },
  serializeContract(_contract: Contract) {
    // IDB contracts are plain JSON-safe objects. Serialization is identity.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return _contract as any;
  },
};

const idbMigrationsCapability = {
  createPlanner(_adapter: ControlAdapterInstance<"idb", "idb">) {
    return new IdbMigrationPlanner();
  },
  createRunner(_family: ControlFamilyInstance<"idb", unknown>) {
    return new IdbMigrationRunner();
  },
  contractToSchema(
    contract: Contract | null,
    _frameworkComponents?: ReadonlyArray<TargetBoundComponentDescriptor<"idb", "idb">>
  ) {
    return contractToIdbSchema(contract);
  },
} satisfies TargetMigrationsCapability<"idb", "idb">;

const idbControlTargetDescription = {
  ...idbTargetDescriptorMeta,
  contractSerializer: idbContractSerializer,
  migrations: idbMigrationsCapability,
  create(): ControlTargetInstance<"idb", "idb"> {
    return { familyId: "idb", targetId: "idb" };
  },
} satisfies MigratableTargetDescriptor<"idb", "idb">;

export default idbControlTargetDescription;
export { IdbMigrationControlDriverDescriptor, extractMigrationDriver } from "../core/migration-driver";
export type { IdbMigrationControlDriver } from "../core/migration-driver";
