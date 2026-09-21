import { afterAll, beforeAll, beforeEach } from "vitest";
import { closeTestDb, resetTestDb, testDb } from "./helpers";

beforeAll(async () => {
  await testDb();
});

beforeEach(async () => {
  await resetTestDb();
});

afterAll(async () => {
  await closeTestDb();
});
