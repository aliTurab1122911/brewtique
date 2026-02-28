export default function DashboardPage() {
  return (
    <main style={{ padding: 24, fontFamily: "Inter, sans-serif" }}>
      <h1>Brewtique Hub Dashboard</h1>
      <p>Monolithic multi-tenant dashboard scaffold is in place.</p>
      <ul>
        <li>Public check-in API endpoint: <code>/api/public/:tenantSlug/checkin</code></li>
        <li>WhatsApp webhook endpoint: <code>/api/webhooks/whatsapp</code></li>
        <li>Core data model: Prisma schema in <code>prisma/schema.prisma</code></li>
      </ul>
    </main>
  );
}
