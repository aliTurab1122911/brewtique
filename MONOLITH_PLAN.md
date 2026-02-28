# Brewtique Hub Monolith (Node + TypeScript + Next.js + PostgreSQL)

This repository now includes the first runnable scaffold of the new direction:

- Multi-tenant PostgreSQL schema (`prisma/schema.prisma`)
- Public check-in ingestion endpoint (`POST /api/public/:tenantSlug/checkin`)
- Profile upsert + duplicate detection service (`src/lib/checkin-service.ts`)
- WhatsApp webhook skeleton (`/api/webhooks/whatsapp`)
- Minimal dashboard page (`/dashboard`)

## Core concepts implemented

- **Tenant-scoped check-ins** and **tenant-scoped unique customer profiles**
- Duplicate check by `tenant + phone_e164 + UTC day`
- Profile visit rollover:
  - `lastVisitAt <- currentVisitAt`
  - `currentVisitAt <- now`
  - `durationDays <- difference`
  - `visitCount += 1`
- Category computation using configurable windows:
  - `loyalWindowDays`
  - `loyalMinVisits`
  - `irregularAfterDays`

## Next steps

1. Add tenant/admin auth and dashboard RBAC.
2. Add a proper table UI for sign-ins and profiles.
3. Add queue processor + WhatsApp dispatch worker.
4. Add webhook message-id reconciliation into queue/profile states.
5. Add DigitalOcean deployment files (Docker + app spec).
