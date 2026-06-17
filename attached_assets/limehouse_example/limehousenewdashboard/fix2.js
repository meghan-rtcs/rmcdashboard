const fs = require("fs");

// ═══ FIX aggregator.js ═══
let agg = fs.readFileSync("server/lib/aggregator.js", "utf8");

// Fix month order: Jan → current month (not backwards)
agg = agg.replace(
  "for (let i = ytdMonthCount - 1; i >= 0; i--) {\n    const d = new Date(Date.UTC(now.getUTCFullYear(), i, 1));",
  "for (let i = 0; i < ytdMonthCount; i++) {\n    const d = new Date(Date.UTC(now.getUTCFullYear(), i, 1));"
);

fs.writeFileSync("server/lib/aggregator.js", agg);
console.log("+ Fixed month order (Jan → May)");

// ═══ FIX var-a.jsx ═══
let jsx = fs.readFileSync("Limehouse Revamp/components/var-a.jsx", "utf8");

// Fix chart title
jsx = jsx.replace(
  'title="Gross & Net income — 12 months"',
  'title="Gross & Net Income — YTD"'
);
jsx = jsx.replace(
  "Monthly totals (thousands)",
  "Monthly totals"
);

// Fix the Y-axis on the income chart — values are now full dollars
// The LineChart yFmt needs to show $XXXk instead of raw numbers
jsx = jsx.replace(
  /yFmt=\{[^}]*\}([\s\S]*?key: 'gross')/,
  "yFmt={(v) => '$' + Math.round(v/1000) + 'k'}$1"
);

fs.writeFileSync("Limehouse Revamp/components/var-a.jsx", jsx);
console.log("+ Fixed chart title and Y-axis labels");

// Check if YoY charts exist
if (jsx.includes("GOIYoYChart")) {
  console.log("+ YoY charts already present");
} else {
  console.log("! YoY charts NOT found — run fix-dashboard.js first");
}

console.log("\nDone! Run: node server/index.js");