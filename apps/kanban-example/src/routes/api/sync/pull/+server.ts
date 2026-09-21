import { pullAndMaterializeLogs } from "$lib/prisma-idb/server/batch-processor";
import { auth } from "$lib/server/auth";
import { prisma } from "$lib/server/prisma";
import z from "zod";

export async function POST({ request }) {
  let pullRequestBody;
  try {
    pullRequestBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Malformed JSON" }), { status: 400 });
  }

  const parsed = z.object({ lastChangelogId: z.uuidv7().optional() }).safeParse(pullRequestBody);

  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid request", details: parsed.error }), {
      status: 400,
    });
  }

  const authResult = await auth.api.getSession({ headers: request.headers });
  if (!authResult?.user.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const logsWithRecords = await pullAndMaterializeLogs({
    prisma,
    scopeKey: authResult.user.id,
    lastChangelogId: parsed.data.lastChangelogId,
  });

  return new Response(
    JSON.stringify({
      cursor: logsWithRecords.at(-1)?.id ?? parsed.data.lastChangelogId ?? null,
      logsWithRecords,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
