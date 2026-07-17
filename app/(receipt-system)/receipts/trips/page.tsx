import { listBusinessTripsWithCounts } from "@/lib/receipts/db";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { TripsScreen } from "@/components/receipts/trips/trips-screen";

export const dynamic = "force-dynamic";

export default async function TripsPage() {
  await assertReceiptsPageAccess();
  const trips = await listBusinessTripsWithCounts();
  return <TripsScreen initialTrips={trips} />;
}
