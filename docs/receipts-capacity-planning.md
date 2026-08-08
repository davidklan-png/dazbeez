# Receipts capacity and archival plan

**Status:** Current planning baseline

**Baseline date:** 2026-07-24

**Owner:** Architect + operator

**Applies to:** Receipts Worker routes, D1 `dazbeez-receipts`, R2
`dazbeez-receipts`, R2 `dazbeez-receipts-archive`, Cloudflare Queues, and the
Mac MLX extraction consumer

**Related:** [ADR 0005](adr/0005-multi-open-month-assumption.md),
[queue control-plane runbook](runbooks/receipts-queue-control-plane.md),
[month-close runbook](month-close-runbook.md)

## 1. Executive conclusion

The receipts module is not close to a compute, database, queue, or object
storage limit. At the July 2026 high-water workload:

- D1 has decades of storage headroom.
- R2 would take approximately 12–13 years to reach a 10 GiB planning waypoint.
  That waypoint is a review trigger, not an R2 hard limit.
- Worker request volume has roughly 75x headroom within the current included
  request allowance.
- Worker CPU consumption has roughly 6x headroom within the current included
  CPU allowance. Exceeding the allowance is primarily a cost threshold on the
  paid plan, not an expected service interruption.
- The extraction queue is empty and every receipt has reached a terminal
  processed state.

The first scaling risks are therefore **query shape, audit-log growth,
observability, and archive integrity**, not raw capacity. Month-scoped list
queries and a complete archive artifact catalog should be implemented before
adding storage infrastructure or physically moving receipt originals.

## 2. Scope and interpretation

This plan uses read-only production measurements from June and July 2026 plus
the August statement population known on 2026-07-24. It distinguishes:

- **Capture month:** when a receipt object was uploaded.
- **Statement month:** the AMEX or non-AMEX accounting period to which a
  receipt belongs.
- **Object write month:** when an R2 object was created or replaced.

These are not interchangeable. For example, the June export bundle was built
on July 21, so its bytes appear in July's R2 write growth.

July is used as the conservative planning month because it contains 91
captures, a proof-copy backfill, and the June export bundle. June has only
eight captures, and August has no captures yet because the snapshot predates
August. This is sufficient for an engineering envelope, but not for a seasonal
forecast.

## 3. Measured production baseline

### 3.1 Workload

| Measure | June 2026 | July 2026 | August 2026 |
|---|---:|---:|---:|
| Receipts captured | 8 | 91 | 0 as of Jul 24 |
| Combined statement-month receipts | 38 | 24 | 25 |
| AMEX statement lines | 32 | 20 | 27 |
| Confirmed AMEX lines | 29 | 16 | 25 |

There are 115 receipt records in total. All are
`extraction_state='processed'`; the effective extraction backlog is zero.

### 3.2 D1

| Measure | Observed |
|---|---:|
| Database size | 7,794,688 B / 7.43 MiB |
| Tables | 28 |
| 24-hour read queries | 1,332 |
| 24-hour write queries | 16 |
| 24-hour rows read | 41,103 |
| 24-hour rows written | 75 |
| Audit rows | 3,422 |

The audit log, rather than receipt metadata, is the dominant D1 consumer.
July produced 2,999 audit rows and approximately 3.3 MiB of audit JSON. The
`search_text` and `compliance_warnings_json` fields are unpopulated, and
`extraction_json` is small relative to the audit history.

### 3.3 R2

The R2 inventory was enumerated exhaustively using a temporary, bucket-scoped,
Object Read-only credential. The credential was removed and the Cloudflare
token was revoked after the inventory.

| Bucket | Objects | Bytes | MiB | Zero-byte |
|---|---:|---:|---:|---:|
| `dazbeez-receipts` | 239 | 113,476,186 | 108.22 | 0 |
| `dazbeez-receipts-archive` | 14 | 6,136,149 | 5.85 | 0 |
| **Total** | **253** | **119,612,335** | **114.07** | **0** |

Storage composition:

| Non-overlapping category | Objects | Bytes | Share |
|---|---:|---:|---:|
| Receipt originals | 115 | 95,805,225 | 80.1% |
| Receipt derivatives | 108 | 17,591,133 | 14.7% |
| Other receipts-bucket objects | 16 | 79,828 | <0.1% |
| Archive-bucket objects | 14 | 6,136,149 | 5.1% |

The average original is approximately 833 KiB. Derivatives add approximately
18% over the original-byte population, primarily from proof copies. A
finalized-month export is expected to add approximately 6 MiB, dominated by
`proofs.zip`.

Integrity status is healthy:

- No D1-referenced R2 object is missing.
- No zero-byte object exists.
- No duplicate object reference or dangling D1 row was found.
- Nineteen unreferenced objects consume only 30,073 B.
- Twelve soft-deleted receipts retain 8.8 MiB of source objects. They are
  intentionally referenced pending a retention decision.

The earlier report that three June export artifacts were missing was a false
negative caused by checking the receipts bucket. All three objects exist in
the archive bucket, together with the rest of the bundle.

### 3.4 Worker and queue

The current project baseline is approximately:

| Measure | Current | Included baseline | Headroom |
|---|---:|---:|---:|
| Worker requests | ~132,000/month | 10,000,000/month | ~75x |
| Worker CPU | ~5M CPU-ms/month | 30M CPU-ms/month | ~6x |
| Average request CPU | ~38 ms | 30 s request ceiling | Not close |
| Queue backlog | 0 | — | Healthy |
| Queue retention | 24 hours | — | p95 extraction latency is ~66 minutes |

The Mac consumer pulls batches of 10, supplies a five-minute visibility
timeout on each pull, and polls every 20 seconds while active. The configured
control-plane default remains 12 hours; it is overridden by the current
consumer but remains a risk for any future consumer that omits the override.

July extraction latency was approximately 8.4 minutes at p50 and 66 minutes at
p95. This is end-to-end latency, not model service time, so it cannot be used
to calculate Mac CPU throughput directly.

## 4. Capacity forecast

### 4.1 D1 storage

Using a conservative 4–6 MiB/month D1 growth band, driven mostly by July-like
audit activity:

| Point | Forecast |
|---|---:|
| Current utilization of 5 GiB | ~0.15% |
| Time to 1 GiB review threshold | ~14–21 years |
| Time to 5 GiB at unchanged workload | ~70–105 years |

These are storage calculations, not a recommendation to retain all audit
payloads for a century. Query performance and business retention requirements
should trigger action much earlier.

At the observed daily rate, D1 reads and writes remain orders of magnitude
below the paid-plan allowances. Month-scoped queries are still required
because a global list can become slow or silently incomplete long before D1
reaches a quota.

### 4.2 R2 storage

July wrote approximately 65 MiB to the receipts bucket and 6 MiB to the archive
bucket. A conservative steady-state band is therefore 65–72 MiB/month.

| Planning waypoint | Forecast at 65–72 MiB/month |
|---|---:|
| 1 GiB | ~13–14 months from baseline |
| 10 GiB | ~12–13 years |
| 100 GiB | ~118–131 years |

The 1 GiB point requires observation, not remediation. The 10 GiB point is a
useful cost and lifecycle review. Neither is an R2 service limit.

If July's proof-copy work was largely a one-time backfill, these forecasts are
conservative and actual growth will be slower.

### 4.3 Worker CPU and request volume

Worker CPU is the nearer commercial threshold:

- Current CPU usage can grow about 6x before exceeding the included monthly
  CPU allowance.
- At 25% annual growth, 6x consumption is roughly eight years away.
- At 50% annual growth, it is roughly four years away.
- At 100% annual growth, it is roughly 2.5 years away.

These are cost-envelope estimates. Per-request performance must be evaluated
separately using Workers Logs because monthly aggregate headroom can hide one
expensive route.

Request count is not the limiting dimension: current request volume can grow
roughly 75x before reaching the included request allowance.

### 4.4 Memory and Mac extraction

No exceeded-memory condition or persistent queue backlog has been observed.
Stored receipt volume does not accumulate in Worker memory because D1 and R2
are external services.

A numerical Mac CPU/RAM forecast is not yet defensible. The missing
measurements are:

- model cold-start duration and peak resident memory;
- per-page and per-receipt processing duration;
- batch processing duration;
- CPU/GPU utilization during a representative multi-page PDF;
- queue oldest-message age while a batch is running.

Operational evidence nevertheless shows that the current Mac processes at
least the July workload without a persistent backlog. Resource telemetry is a
measurement follow-up, not a capacity incident.

## 5. Operational thresholds

Capacity should be reviewed on thresholds rather than on a fixed calendar
prediction alone.

| Resource | Warning | Action |
|---|---|---|
| Worker CPU | 15M CPU-ms/month (50% included) | 24M (80%) or recurrent CPU exceptions |
| Worker requests | 5M/month | 8M/month |
| D1 storage | 512 MiB | 1 GiB or sustained >10 MiB/month |
| R2 storage | 1 GiB | 10 GiB or >150 MiB/month for 3 months |
| Queue | oldest message >2 hours | oldest >12 hours, any unexplained DLQ item, or retained backlog |
| Extraction latency | p95 >2 hours | p95 >12 hours or any message nearing 24-hour retention |
| Archive integrity | any unreferenced sealed artifact | missing/zero-byte/hash-mismatched referenced artifact |
| Soft deletes | 100 objects or 100 MiB | retention review before either doubles |

The threshold values are operator alerts, not automatic deletion or
finalization triggers.

## 6. Archival architecture

### 6.1 Lifecycle tiers

Use logical lifecycle tiers without physically moving source originals:

1. **Hot:** the normal 3–4 concurrent open statement months from ADR 0005.
   Full review, reconciliation, extraction, and editing remain available.
2. **Finalizing:** a complete export bundle is built, hashed, uploaded, and
   verified. The month is not yet immutable.
3. **Sealed:** finalize locks the accounting month and its verified artifact
   catalog. Sealed objects are never overwritten.
4. **Retained:** finalized metadata remains searchable through a compact D1
   index while R2 holds the complete evidence bundle.
5. **Disposition pending:** an expired soft-deleted or superseded object is
   eligible for a reviewed purge only if retention and legal-hold policy allow
   it.

R2 has ample capacity, and the application currently depends on stable source
keys. Moving originals into another bucket would add failure modes without a
current performance or cost benefit.

### 6.2 Self-contained export

Retain the existing export-id-scoped bundle under:

```text
exports/<statement-month>/<export-id>-<artifact>
```

The eight-file export bundle and any related reconciliation manifest must be
cataloged individually. A proposed D1 table is:

```text
receipt_export_artifacts
  id
  export_id
  statement_month
  artifact_type
  r2_key
  byte_size
  sha256
  etag
  artifact_status
  created_at
  verified_at
  sealed_at
  retention_until
  legal_hold
  superseded_by_artifact_id
```

`r2_key` should be unique. Finalize must verify that all required artifact
types are present, non-zero, and hash-consistent before sealing the export.

### 6.3 Safe build and finalize sequence

R2 writes and D1 writes are not one transaction. The pipeline should therefore
use explicit stages:

1. Generate all artifacts and calculate sizes and hashes.
2. Upload the complete bundle.
3. HEAD every object and verify key, size, and ETag/hash evidence.
4. In one D1 transaction, persist every artifact row and mark the draft
   `bundle_ready`.
5. Run all month-close and cross-month validation.
6. Seal the export and artifact rows in one D1 transaction.
7. Emit a visible failure if any cleanup or verification step fails.

A failed build remains a visible draft and is safe to retry. A finalized
artifact is never deleted by ordinary draft cleanup.

### 6.4 Supersession and cleanup

The inventory found two small orphan sources:

- Nine superseded SAISON statement CSVs remain after their D1 artifact rows are
  replaced.
- Five files belong to stale draft export bundles with null artifact keys.

The replacement policy should be:

1. Write and verify the replacement.
2. Commit its D1 reference.
3. Mark the previous artifact or draft as superseded.
4. Delete only superseded, unsealed objects.
5. Record success or expose cleanup failure to the operator.

The five companion files belonging to the live June export are not orphans.
They demonstrate why every bundle member needs an artifact-catalog row.

### 6.5 Retention

No automatic receipt purge should be introduced until the operator confirms
the applicable accounting and legal retention periods. Until then:

- finalized bundles are retained indefinitely;
- legal hold always blocks deletion;
- soft-deleted source objects remain referenced and recoverable;
- purge candidates are produced by a dry-run inventory;
- every material deletion requires an audit record and post-delete
  verification.

The current 12 soft-deleted originals consume only 8.8 MiB, so there is no
capacity pressure to decide prematurely.

## 7. Prioritized work

### Near term

1. Refactor list and queue views to use month-scoped, column-projected queries
   that omit `extraction_json`.
2. Add `receipt_export_artifacts` and catalog every export and reconciliation
   object.
3. Make AMEX/SAISON replacement clean up the superseded R2 statement object
   after successful replacement.
4. Clean abandoned same-month draft bundles without touching sealed exports.

### Measurement follow-up

5. Capture seven representative days of per-route Worker CPU and request data.
6. Measure Mac MLX peak memory and actual service time for single-page and
   multi-page receipts.
7. Record queue oldest-message age and DLQ count in each manual capacity
   review.

### Policy follow-up

8. Confirm soft-delete and finalized-accounting retention periods.
9. Decide whether audit payloads require indefinite hot retention or can be
   compacted after a defined period.

Automation for these measurements and cleanup operations is intentionally
parked. None of the thresholds in this document authorizes automatic data
deletion, finalization, or Cloudflare control-plane mutation.

## 8. Review cadence

Repeat the capacity snapshot after:

- three complete normal operating months;
- any month exceeding 150 captures;
- a sustained queue backlog;
- a Worker CPU warning threshold;
- a material extraction-model change;
- a change to proof-copy or export-bundle construction.

At each review, record capture counts, statement counts, D1 size and audit
growth, exhaustive R2 counts/bytes, Worker per-route CPU, queue oldest age, DLQ
count, and Mac extraction resource measurements. Recalculate the forecast from
the rolling three-month median and the worst observed month.
