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
 * IDB contract serializer — identity in both directions.
 *
 * IDB contracts are TypeScript-first (`defineContract`), so they are
 * already plain, JSON-safe objects with no class instances.
 */
const idbContractSerializer: ContractSerializer<Contract> = {
  deserializeContract<T extends Contract = Contract>(json: unknown): T {
    return json as T;
  },
  serializeContract(contract: Contract) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return contract as any;
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
