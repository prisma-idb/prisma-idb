import type {
  ControlAdapterDescriptor,
  ControlAdapterInstance,
  ControlStack,
} from "@prisma/orm-framework/components/control";
import { idbAdapterDescriptorMeta } from "../core/descriptor-meta";

const idbControlAdapterDescriptor: ControlAdapterDescriptor<"idb", "idb"> = {
  ...idbAdapterDescriptorMeta,
  create(_stack: ControlStack<"idb", "idb">): ControlAdapterInstance<"idb", "idb"> {
    return { familyId: "idb", targetId: "idb" };
  },
};

export default idbControlAdapterDescriptor;
