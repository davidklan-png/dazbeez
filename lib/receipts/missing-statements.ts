// Global statement expectation; dashboard applies actor dismissals afterwards.
export function expectedStatementMonths(today: Date) {
  const months: { statementMonth: string; expectedReadyDate: string }[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
    const ready = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 18));
    const expectedReadyDate = ready.toISOString().slice(0, 10);
    if (today.toISOString().slice(0, 10) >= expectedReadyDate) {
      months.push({ statementMonth: d.toISOString().slice(0, 7), expectedReadyDate });
    }
  }
  return months;
}

// Same artifact eligibility as getAmexArtifactByMonth; uploaded/parsed count,
// failed/replaced do not. Dismissals are operator-specific and never used by cron.
export const PRESENT_STATEMENT_SQL = `SELECT DISTINCT statement_month
  FROM amex_statement_artifacts WHERE import_status NOT IN ('failed','replaced')`;
