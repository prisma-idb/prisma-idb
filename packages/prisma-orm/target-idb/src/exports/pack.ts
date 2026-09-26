import { idbTargetDescriptorMeta } from "../core/descriptor-meta";

export default idbTargetDescriptorMeta;
export type { CodecTypes } from "../core/codec-types";
export type {
  IdbContractWithTypeMaps,
  IdbIndexDefinition,
  IdbKeyPath,
  IdbModelStorage,
  IdbMutationDefaultGeneratorId,
  IdbReferentialAction,
  IdbRelationStorage,
  IdbStoreDefinition,
  IdbStorage,
  IdbTypeMaps,
  ExtractIdbTypeMaps,
  ExtractIdbFieldOutputTypes,
  ExtractIdbFieldInputTypes,
} from "../core/idb-contract-types";
export { keyPathEquals, keyPathFields } from "../core/idb-contract-types";
