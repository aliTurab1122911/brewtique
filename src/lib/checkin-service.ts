import { DeliveryStatus, MessageState, ProfileCategory, SignInStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { computeCategory, daysBetween, toUtcDateOnly } from "@/lib/category";
import { normalizePhoneE164, splitE164 } from "@/lib/phone";

export const checkinSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().optional(),
  phone_e164: z.string().optional(),
  phone_raw: z.string().optional(),
  ip: z.string().optional(),
  user_agent: z.string().optional()
});

export async function ingestCheckin(tenantSlug: string, payload: unknown) {
  const parsed = checkinSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false as const, error: "INVALID_PAYLOAD" };
  }

  const tenant = await db.tenant.findUnique({
    where: { slug: tenantSlug },
    include: { settings: true }
  });

  if (!tenant) return { ok: false as const, error: "TENANT_NOT_FOUND" };

  const rawPhone = parsed.data.phone_raw ?? parsed.data.phone ?? "";
  const phoneE164 = normalizePhoneE164(parsed.data.phone_e164 ?? rawPhone);
  if (!phoneE164) return { ok: false as const, error: "INVALID_PHONE" };

  const split = splitE164(phoneE164);
  const now = new Date();
  const dateUtc = toUtcDateOnly(now);

  const duplicate = await db.signIn.findFirst({
    where: {
      tenantId: tenant.id,
      phoneE164,
      dateUtc
    },
    select: { id: true }
  });

  const signIn = await db.signIn.create({
    data: {
      tenantId: tenant.id,
      occurredAtUtc: now,
      dateUtc,
      timestampPt: now,
      name: parsed.data.name,
      countryCode: split.countryCode,
      nationalNumber: split.nationalNumber,
      phoneE164,
      whatsappLink: split.whatsappLink,
      ip: parsed.data.ip,
      status: duplicate ? SignInStatus.duplicate_same_day : SignInStatus.new_entry,
      rawPayload: parsed.data
    }
  });

  const existingProfile = await db.customerProfile.findUnique({
    where: {
      tenantId_phoneE164: {
        tenantId: tenant.id,
        phoneE164
      }
    }
  });

  const settings = tenant.settings ?? {
    loyalWindowDays: 7,
    loyalMinVisits: 2,
    irregularAfterDays: 14
  };

  if (!existingProfile) {
    await db.customerProfile.create({
      data: {
        tenantId: tenant.id,
        phoneE164,
        name: parsed.data.name,
        countryCode: split.countryCode,
        nationalNumber: split.nationalNumber,
        firstCheckinAt: now,
        currentVisitAt: now,
        visitCount: 1,
        lastCategory: ProfileCategory.new,
        messageIsSent: MessageState.false_flag,
        status: DeliveryStatus.not_sent
      }
    });
  } else {
    const lastVisit = existingProfile.currentVisitAt;
    const currentVisit = now;
    const durationDays = daysBetween(lastVisit, currentVisit);
    const visitCount = existingProfile.visitCount + 1;

    const category = computeCategory({
      visitCount,
      durationDays,
      loyalWindowDays: settings.loyalWindowDays,
      loyalMinVisits: settings.loyalMinVisits,
      irregularAfterDays: settings.irregularAfterDays
    });

    await db.customerProfile.update({
      where: {
        tenantId_phoneE164: {
          tenantId: tenant.id,
          phoneE164
        }
      },
      data: {
        name: parsed.data.name,
        countryCode: split.countryCode,
        nationalNumber: split.nationalNumber,
        lastVisitAt: lastVisit,
        currentVisitAt: currentVisit,
        durationDays,
        visitCount,
        lastCategory: category
      }
    });
  }

  return {
    ok: true as const,
    signInId: signIn.id,
    duplicateSameDay: !!duplicate,
    phoneE164
  };
}
