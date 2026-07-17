import { notFound } from "next/navigation";
import { getBusinessTripWithMembers } from "@/lib/receipts/db";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { TripDetailScreen } from "@/components/receipts/trips/trip-detail-screen";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function TripDetailPage({ params }: PageProps) {
  await assertReceiptsPageAccess();
  const { id } = await params;
  const detail = await getBusinessTripWithMembers(id);
  if (!detail.trip) notFound();

  return (
    <TripDetailScreen
      trip={detail.trip}
      lines={detail.lines}
      receipts={detail.receipts}
    />
  );
}
