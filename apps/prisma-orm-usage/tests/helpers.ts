/**
 * Test helpers for driving the Prisma IDB query-runner shell.
 *
 * The shell on `/` accepts a JS expression in a textarea and runs it
 * against `orm` (the auto-migrated client) inside a sandbox with
 * `and` / `or` / `not` in scope. Tests submit an expression and read
 * the JSON output panel (or the error alert).
 *
 * Per-spec isolation: each test calls `gotoFreshDb(page)` which navigates
 * to `/?db=<unique>` and then clicks "Reset DB" to guarantee an empty
 * IDB database. The dbName is derived from the Playwright test info so
 * parallel workers can't collide.
 */
import { expect, type Page, test as base } from "@playwright/test";

let dbCounter = 0;

/**
 * Build a unique IDB database name for the current test. Includes the
 * worker index + a sequence number so parallel workers stay isolated.
 */
function uniqueDbName(workerIndex: number): string {
  return `pn-test-w${workerIndex}-${++dbCounter}-${Date.now().toString(36)}`;
}

/**
 * Custom fixture that navigates to the shell with a unique db name and
 * resets the database before each test.
 */
export const test = base.extend<{ runner: QueryRunner }>({
  runner: async ({ page }, use, testInfo) => {
    const dbName = uniqueDbName(testInfo.workerIndex);
    await page.goto(`/?db=${dbName}`);
    // Wait for the badge to show our dbName before kicking off the reset.
    await expect(page.getByTestId("db-name")).toHaveText(dbName);
    // Reset to clear anything that lingered from a previous test run.
    await page.getByTestId("reset-db").click();
    // After reset, the Run button re-enables once the client is rebuilt.
    await expect(page.getByTestId("run-query")).toBeEnabled({ timeout: 10_000 });
    await use(new QueryRunner(page));
  },
});

export { expect };

/** Driver around the query textarea + Run button. */
export class QueryRunner {
  constructor(private readonly page: Page) {}

  /**
   * Submit an expression and wait for either an `ok` or `error` panel.
   * Returns the parsed JSON value on success; throws (with the rendered
   * error text) on failure.
   */
  async run(expression: string): Promise<unknown> {
    const input = this.page.getByTestId("query-input");
    await input.fill(expression);
    // The previous run's panel (if any) might still be visible, so we
    // wait for the Run button to drop back into the enabled state
    // before treating the next panel state as the new outcome.
    await this.page.getByTestId("run-query").click();
    // The Run button disables while a query is in flight; wait for it
    // to re-enable so we know the new result has been written.
    await expect(this.page.getByTestId("run-query")).toBeEnabled({ timeout: 10_000 });
    const okPanel = this.page.getByTestId("result-ok");
    const errPanel = this.page.getByTestId("result-error");
    if (await errPanel.isVisible()) {
      const text = await this.page.getByTestId("result-text").innerText();
      throw new Error(`Query failed: ${text}`);
    }
    await expect(okPanel).toBeVisible({ timeout: 10_000 });
    const raw = await this.page.getByTestId("result-text").innerText();
    // The shell normalises `undefined`-valued results to JSON `null`,
    // so an empty string here always indicates a real problem.
    if (raw.trim().length === 0) {
      throw new Error(`Empty result panel (expression: ${expression})`);
    }
    return JSON.parse(raw);
  }

  /** Run an expression and assert it throws with an error containing `match`. */
  async expectError(expression: string, match: string | RegExp): Promise<void> {
    const input = this.page.getByTestId("query-input");
    await input.fill(expression);
    await this.page.getByTestId("run-query").click();
    const errPanel = this.page.getByTestId("result-error");
    await expect(errPanel).toBeVisible({ timeout: 10_000 });
    const text = await this.page.getByTestId("result-text").innerText();
    if (typeof match === "string") {
      expect(text).toContain(match);
    } else {
      expect(text).toMatch(match);
    }
  }
}
