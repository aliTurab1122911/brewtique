import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && token === process.env.META_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => null);
  // TODO: persist webhook events + map message ids to queue/profile updates.
  return NextResponse.json({ ok: true, received: !!payload });
}
