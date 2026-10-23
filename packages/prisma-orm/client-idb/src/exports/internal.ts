/** @internal Shared mutation implementation for companion IDB packages. */
export { collectDeleteStoreNames, applyReferentialActionsForRow } from "../core/mutation-executor";

export {
  decimalKeysEqual,
  hasDecimalPrimaryKey,
  preserveDecimalKeySpelling,
  resolveDecimalKey,
  withDecimalIdentityScope,
  IdbDecimalIdentityConflictError,
} from "../core/decimal-identity";

export { createIdbEnums } from "../core/enum-accessors";
