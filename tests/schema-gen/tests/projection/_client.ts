import "fake-indexeddb/auto";
import path from "path";
import type { GeneratedProject } from "./_generate";

/** The subset of a generated model delegate that the tests call. */
export interface Delegate {
  createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

/** A generated `PrismaIDBClient`: one delegate per model, addressed by its lower-camel name. */
export type GeneratedClient = Record<string, Delegate>;

/**
 * Imports the generated IndexedDB client and returns it with an empty database.
 *
 * The client is a singleton on a fixed database name. A test file therefore opens at most one
 * generated project; open a second project from a separate file.
 */
export async function openClient(project: GeneratedProject): Promise<GeneratedClient> {
  const { PrismaIDBClient } = await import(/* @vite-ignore */ path.join(project.idbDir, "client", "index.ts"));
  const client = await PrismaIDBClient.createClient();
  await client.resetDatabase();
  return client;
}
