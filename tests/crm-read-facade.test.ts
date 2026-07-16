import test from "node:test";
import assert from "node:assert/strict";
import {
  listBatches as facadeListBatches,
  getDashboardSummary as facadeGetDashboardSummary,
  getBatchDetail as facadeGetBatchDetail,
  listContacts as facadeListContacts,
  listCompanies as facadeListCompanies,
  listReviewTasks as facadeListReviewTasks,
  listDrafts as facadeListDrafts,
  getContactDetail as facadeGetContactDetail,
} from "@/lib/crm";
import {
  listBatches,
  getDashboardSummary,
  getBatchDetail,
  listContacts,
  listCompanies,
  listReviewTasks,
  listDrafts,
  getContactDetail,
} from "@/lib/crm-reads";

test("facade re-exports are strictly identical to crm-reads functions", () => {
  const pairs = [
    ["listBatches", facadeListBatches, listBatches],
    ["getDashboardSummary", facadeGetDashboardSummary, getDashboardSummary],
    ["getBatchDetail", facadeGetBatchDetail, getBatchDetail],
    ["listContacts", facadeListContacts, listContacts],
    ["listCompanies", facadeListCompanies, listCompanies],
    ["listReviewTasks", facadeListReviewTasks, listReviewTasks],
    ["listDrafts", facadeListDrafts, listDrafts],
    ["getContactDetail", facadeGetContactDetail, getContactDetail],
  ];
  for (const [name, facadeFn, directFn] of pairs) {
    assert.strictEqual(facadeFn, directFn, `${name} facade must be the same function object`);
  }
});
