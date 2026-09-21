import { applyPush } from "$lib/prisma-idb/server/batch-processor";
import { outboxEventSchema } from "$lib/prisma-idb/validators";
import { auth } from "$lib/server/auth";
import { prisma } from "$lib/server/prisma";
import z from "zod";

export async function POST({ request }) {
  let pushRequestBody;
  try {
    pushRequestBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Malformed JSON" }), { status: 400 });
  }

  const parsed = z.object({ events: z.array(outboxEventSchema) }).safeParse({
    events: pushRequestBody.events,
  });

  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid request", details: parsed.error }), {
      status: 400,
    });
  }

  const authResult = await auth.api.getSession({ headers: request.headers });
  if (!authResult?.user.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  let pushResults;
  try {
    pushResults = await applyPush({
      events: parsed.data.events,
      scopeKey: authResult.user.id,
      prisma,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Batch size") ? 413 : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(pushResults), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
