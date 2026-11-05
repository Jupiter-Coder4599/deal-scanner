// Combines every store chain's results into deals.json (for the app) and deals.md (readable in GitHub)
const fs = require("fs");
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; } };
const files = fs.readdirSync(".").filter(f => f.endsWith("-deals.json"));

const list = files.flatMap(read).map(it => {
  const prices = it.stores.map(s => s.price);
  const best = prices.length ? Math.min(...prices) : it.onlinePrice;
  return { ...it, bestPrice: best, stores: it.stores.sort((a, b) => a.price - b.price) };
}).filter(it => typeof it.bestPrice === "number").sort((a, b) => a.bestPrice - b.bestPrice);

fs.writeFileSync("deals.json", JSON.stringify({ updated: new Date().toISOString(), count: list.length, deals: list }, null, 2));

const md = [`# Harris County deals — ${list.length} items`,
  `Updated ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`, ""];
for (const it of list) {
  md.push(`### $${it.bestPrice.toFixed(2)} — [${it.title}](${it.url})`);
  md.push(`${it.chain} · regular $${Number(it.regular || 0).toFixed(2)}`);
  if (it.stores.length) {
    for (const s of it.stores) md.push(`- $${s.price.toFixed(2)} at ${s.name}${s.city ? " (" + s.city + ")" : ""}${s.lowStock ? " — low stock" : ""}`);
  } else md.push(`- Online price (no local stock confirmed)`);
  md.push("");
}
fs.writeFileSync("deals.md", md.join("\n"));
console.log(`Merged ${list.length} items from ${files.join(", ")}`);
