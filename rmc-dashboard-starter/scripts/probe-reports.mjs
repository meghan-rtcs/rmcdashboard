import { appfolio } from "../server/lib/appfolio.js";

const today = new Date().toISOString().slice(0, 10);
const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

const probes = [
  ["work_order_labor_summary.json", { labor_performed_from: monthAgo, labor_performed_to: today, paginate_results: false }],
  ["renters_insurance.json", { paginate_results: false }],
  ["tenant_tickler.json", { paginate_results: false }],
  ["tickler.json", { paginate_results: false }],
];

for (const [name, body] of probes) {
  try {
    const rows = await appfolio.raw(name, body);
    const arr = Array.isArray(rows) ? rows : rows.results || [];
    console.log(`OK ${name}: ${arr.length} rows`);
    if (arr[0]) console.log(`   keys: ${Object.keys(arr[0]).join(", ")}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message.slice(0, 160)}`);
  }
}

// Inspect insurance-related fields on directories we already fetch
for (const [label, fn, body] of [
  ["vendor_directory", () => appfolio.vendorDirectory({ paginate_results: false })],
  ["property_directory", () => appfolio.propertyDirectory({ paginate_results: false })],
  ["tenant_directory", () => appfolio.tenantDirectory({ paginate_results: false })],
]) {
  try {
    const rows = await fn();
    const keys = rows[0] ? Object.keys(rows[0]) : [];
    const insKeys = keys.filter((k) => /insur|polic|liab|coverage|expir/i.test(k));
    const groupKeys = keys.filter((k) => /^(property_)?groups?(_name)?$|^property_group_id$/i.test(k));
    console.log(`OK ${label}: ${rows.length} rows; insurance-ish keys: ${insKeys.join(", ") || "(none)"}; verified group keys: ${groupKeys.join(", ") || "(none)"}`);
    if (insKeys.length && rows.length) {
      const sample = rows.filter((r) => insKeys.some((k) => r[k])).slice(0, 3);
      for (const s of sample) console.log("   sample:", JSON.stringify(Object.fromEntries(insKeys.map((k) => [k, s[k]]))));
    }
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message.slice(0, 160)}`);
  }
}
