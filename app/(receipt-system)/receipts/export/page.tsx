import { listExports } from "@/lib/receipts/db";
import { MonthlyExportPanel } from "@/components/receipts/monthly-export-panel";

export const dynamic = "force-dynamic";

export default async function ExportPage() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const exports = await listExports();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Monthly Export</h2>
        <p className="mt-1 text-sm text-gray-500">
          Generate and archive the accountant bundle. Finalized exports are
          locked and cannot be overwritten.
        </p>
      </div>

      <MonthlyExportPanel exports={exports} currentMonth={currentMonth} />
    </div>
  );
}
