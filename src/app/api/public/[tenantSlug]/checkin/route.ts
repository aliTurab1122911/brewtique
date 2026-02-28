import { NextRequest, NextResponse } from "next/server";
import { ingestCheckin } from "@/lib/checkin-service";

export async function POST(
  req: NextRequest,
  { params }: { params: { tenantSlug: string } }
) {
  const body = await req.json().catch(() => null);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  const result = await ingestCheckin(params.tenantSlug, {
    ...body,
    ip,
    user_agent: userAgent
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }

  return NextResponse.json(result, { status: 200 });
}
