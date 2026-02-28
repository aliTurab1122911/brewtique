import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: "Inter, sans-serif" }}>
      <h1>Brewtique Hub</h1>
      <p>Centralized customer retention middleware (multi-tenant).</p>
      <Link href="/dashboard">Open dashboard</Link>
    </main>
  );
}
