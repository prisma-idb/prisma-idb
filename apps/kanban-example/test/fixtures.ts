import { test as base, expect, type Page } from "@playwright/test";
import { prisma } from "./prisma";

export const test = base.extend<{ pages: [Page, Page] }>({
  pages: [
    async ({ page, context, browser }, use) => {
      await page.goto("/login");
      await page.getByText("Sign in anonymously (limited features, no sync)").click();
      await page.waitForURL("/dashboard");
      // better-auth's anonymous() plugin, with no emailDomainName configured, issues
      // placeholder addresses under anonymous.placeholder.invalid (no "temp-" prefix).
      await expect(page.getByTestId("user-email")).toContainText("anonymous.placeholder.invalid", {
        timeout: 10000,
      });

      const userEmail = await page.getByTestId("user-email").innerText();
      const cookies = await context.cookies();
      const sessionCookie = cookies.find((cookie) => cookie.name === "__Secure-better-auth.session_token");

      if (!sessionCookie) {
        throw new Error("Session cookie not found");
      }

      const deviceA = await browser.newContext();
      await deviceA.addCookies([sessionCookie]);

      const pageA = await deviceA.newPage();
      await pageA.goto("/dashboard");

      const deviceB = await browser.newContext();
      await deviceB.addCookies([sessionCookie]);

      const pageB = await deviceB.newPage();
      await pageB.goto("/dashboard");

      await use([pageA, pageB]);

      await Promise.all([deviceA.close(), deviceB.close()]);
      await prisma.user.delete({ where: { email: userEmail } });
    },
    { scope: "test" },
  ],
});

export { expect } from "@playwright/test";
