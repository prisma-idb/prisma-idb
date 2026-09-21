import type { ControlDriverDescriptor, ControlDriverInstance } from "@prisma/orm-framework/components/control";
import { idbDriverDescriptorMeta } from "../core/descriptor-meta";

/**
 * Control-plane driver stub for IndexedDB.
 *
 * `ControlDriverInstance` is a SQL-flavoured interface (it exposes `query()`
 * and `close()`), which does not map onto IndexedDB. All IDB control-plane
 * operations (`verify`, `sign`, `db init`, etc.) return structured refusals
 * because IndexedDB only exists in the browser; the CLI runs in Node.js.
 *
 * @see IdbControlFamilyInstance — where the refusal logic lives.
 */
class IdbControlDriver implements ControlDriverInstance<"idb", "idb"> {
  readonly familyId = "idb" as const;
  readonly targetId = "idb" as const;

  async query<Row = Record<string, unknown>>(
    _sql: string,
    _params?: readonly unknown[]
  ): Promise<{ readonly rows: Row[] }> {
    return { rows: [] };
  }

  async close(): Promise<void> {}
}

const idbControlDriverDescriptor: ControlDriverDescriptor<"idb", "idb", IdbControlDriver> = {
  ...idbDriverDescriptorMeta,
  async create(_connection: string): Promise<IdbControlDriver> {
    return new IdbControlDriver();
  },
};

export default idbControlDriverDescriptor;
