// Target hidden-clearance scanner — Harris County, TX
// Node 20+, no dependencies. Uses the same "redsky" API target.com's own site uses.
// 1) Finds every Target near the Harris County ZIPs below
// 2) Searches clearance at EACH store using that store's own prices
// 3) Groups results by item so you can see which stores have it and at what price

const fs = require("fs");

// ---------- SETTINGS (override with GitHub repo variables) ----------
// ZIPs spread across Harris County so the store search covers the whole county
const ZIPS = (process.env.AREA_ZIPS ||
  "77002,77449,77429,77338,77506,77521,77379,77375,77058,77084,77036,77016"
).split(",").map(s => s.trim());
const RADIUS_MILES = process.env.RADIUS_MILES || "12";
const ONLY_COUNTY = "Harris"; // keeps only stores whose county is Harris (when Target reports county)
const KEYWORDS = (process.env.TARGET_KEYWORDS ||
  "clearance,toys clearance,electronics clearance,home clearance,kitchen clearance,tools clearance,beauty clearance,clothing clearance"
).split(",").map(s => s.trim());
const MAX_PRICE = parseFloat(process.env.MAX_PRICE || "5");      // keep items at/under this price...
const MIN_PCT_OFF = parseFloat(process.env.MIN_PCT_OFF || "70"); // ...OR at least this % off
const PAGES = parseInt(process.env.PAGES || "3", 10);            // 24 items per page
// Target's own public web key (not yours). If it ever stops working: open target.com,
// view page source, search "redsky", copy the new key into a TARGET_API_KEY variable.
const API_KEY = process.env.TARGET_API_KEY || "9f36aeafbe60771e321a7cc95a78140772ab3e96";
// --------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const visitorId = [...Array(32)].map(() => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("");
const HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
  origin: "https://www.target.com",
  referer: "https://www.target.com/",
};

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function findStores() {
  if (process.env.TARGET_STORE_IDS) {
    return process.env.TARGET_STORE_IDS.split(",").map(id => ({ storeId: id.trim(), name: `Target #${id.trim()}`, city: "" }));
  }
  const stores = new Map();
  for (const zip of ZIPS) {
    try {
      const p = new URLSearchParams({ key: API_KEY, channel: "WEB", limit: "20", within: RADIUS_MILES, place: zip, page: "/" });
      const json = await getJson(`https://redsky.target.com/redsky_aggregations/v1/web/nearby_stores_v1?${p}`);
      for (const s of json?.data?.nearby_stores?.stores || []) {
        const addr = s.mailing_address || {};
        const county = addr.county || s.county || "";
        if (county && !county.toLowerCase().includes(ONLY_COUNTY.toLowerCase())) continue;
        stores.set(String(s.store_id), {
          storeId: String(s.store_id),
          name: s.location_name || `Target #${s.store_id}`,
          city: addr.city || "",
          address: addr.address_line1 || "",
        });
      }
      console.log(`ZIP ${zip}: ${stores.size} stores so far`);
    } catch (e) {
      console.warn(`store lookup ${zip} failed: ${e.message}`);
    }
    await sleep(800);
  }
  return [...stores.values()];
}

async function searchPage(storeId, keyword, offset) {
  const p = new URLSearchParams({
    key: API_KEY, channel: "WEB", count: "24",
    default_purchasability_filter: "true", // only items purchasable at/for this store
    include_sponsored: "false", keyword, offset: String(offset),
    page: `/s/${keyword}`, platform: "desktop",
    pricing_store_id: storeId, store_ids: storeId, visitor_id: visitorId,
  });
  const json = await getJson(`https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?${p}`);
  return json?.data?.search?.products || [];
}

(async () => {
  const stores = await findStores();
  console.log(`Scanning ${stores.length} Target stores`);
  const items = new Map(); // tcin -> item with per-store prices

  for (const store of stores) {
    for (const keyword of KEYWORDS) {
      for (let page = 0; page < PAGES; page++) {
        let products;
        try { products = await searchPage(store.storeId, keyword, page * 24); }
        catch (e) { console.warn(`skip ${store.storeId} "${keyword}": ${e.message}`); break; }
        if (!products.length) break;

        for (const p of products) {
          const price = p.price || {};
          const current = price.current_retail ?? price.current_retail_min;
          const regular = price.reg_retail ?? price.reg_retail_max ?? current;
          if (typeof current !== "number") continue;
          const pctOff = regular > 0 ? Math.round((1 - current / regular) * 100) : 0;
          if (!(current <= MAX_PRICE || pctOff >= MIN_PCT_OFF)) continue;

          if (!items.has(p.tcin)) {
            items.set(p.tcin, {
              chain: "Target",
              id: p.tcin,
              title: (p.item?.product_description?.title || "Unknown item").replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
              url: p.item?.enrichment?.buy_url || `https://www.target.com/p/-/A-${p.tcin}`,
              image: p.item?.enrichment?.images?.primary_image_url || "",
              regular,
              stores: [],
            });
          }
          const it = items.get(p.tcin);
          if (!it.stores.some(s => s.storeId === store.storeId)) {
            it.stores.push({ ...store, price: current, pctOff });
          }
        }
        console.log(`${store.name} | "${keyword}" p${page + 1}: ${products.length}`);
        await sleep(1500);
      }
    }
  }

  const list = [...items.values()];
  fs.writeFileSync("target-deals.json", JSON.stringify(list, null, 2));
  console.log(`Saved ${list.length} Target items.`);
})();
