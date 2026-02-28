import { ProfileCategory } from "@prisma/client";

export function toUtcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function daysBetween(a: Date, b: Date): number {
  const ms = toUtcDateOnly(b).getTime() - toUtcDateOnly(a).getTime();
  return Math.floor(ms / 86400000);
}

export function computeCategory(params: {
  visitCount: number;
  durationDays: number | null;
  loyalWindowDays: number;
  loyalMinVisits: number;
  irregularAfterDays: number;
}): ProfileCategory {
  const { visitCount, durationDays, loyalWindowDays, loyalMinVisits, irregularAfterDays } = params;

  if (visitCount <= 1) return ProfileCategory.new;
  if (durationDays !== null && durationDays > irregularAfterDays) return ProfileCategory.irregular;
  if (visitCount >= loyalMinVisits && durationDays !== null && durationDays <= loyalWindowDays) {
    return ProfileCategory.loyal;
  }
  return ProfileCategory.new;
}
