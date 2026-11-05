import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, Image, Linking, BackHandler,
  Modal, StyleSheet, ActivityIndicator,
} from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";

// ---- Colors: concrete-floor gray, clearance-tag yellow, store colors ----
const C = {
  bg: "#202326",
  panel: "#2A2E32",
  line: "#3A3F44",
  text: "#F3F1EC",
  muted: "#9BA1A7",
  tag: "#F2C230",      // yellow clearance tag
  tagInk: "#1D1A10",
  target: "#D23B3B",
  depot: "#F26A1B",
};

const TABS = [
  { key: "penny", label: "Penny list", url: "https://www.pennycentral.com/penny-list" },
  { key: "clearance", label: "HD clearance", url: "https://www.pennycentral.com/clearance" },
  { key: "target", label: "Target" },
];

// ---------------- Web tabs (Home Depot penny list + clearance) ----------------
function WebTab({ url, visible, webRef, onNav }) {
  const [loading, setLoading] = useState(true);
  return (
    <View style={[styles.fill, !visible && styles.hidden]}>
      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={styles.web}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onNavigationStateChange={onNav}
        setSupportMultipleWindows={false}
        pullToRefreshEnabled
        // Links to Home Depot / Amazon open in their own apps instead of inside this one
        onShouldStartLoadWithRequest={(req) => {
          if (req.url.startsWith("https://www.pennycentral.com") || req.url.startsWith("about:")) return true;
          Linking.openURL(req.url).catch(() => {});
          return false;
        }}
      />
      {loading && (
        <View style={styles.loader} pointerEvents="none">
          <ActivityIndicator color={C.tag} />
        </View>
      )}
    </View>
  );
}

// ---------------- Target deals (scanned right from your phone) ----------------
// Target blocks GitHub's servers, so the app scans from your own phone instead.
const TGT_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"; // Target's own public web key
const TGT_HEADERS = {
  accept: "application/json",
  origin: "https://www.target.com",
  referer: "https://www.target.com/",
};
const SEARCHES = [
  ["clearance", 6],
  ["toys clearance", 2],
  ["home clearance", 2],
  ["electronics clearance", 2],
  ["kitchen clearance", 2],
  ["tools clearance", 1],
];
const DEFAULT_SETTINGS = { zip: "77002", radius: "15", maxPrice: "5", minOff: "70", selected: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (p) => Object.entries(p).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
const visitorId = Array.from({ length: 32 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("");

async function tgtGet(path, params) {
  const res = await fetch(
    `https://redsky.target.com/redsky_aggregations/v1/web/${path}?${qs({ key: TGT_KEY, channel: "WEB", ...params })}`,
    { headers: TGT_HEADERS }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function findStores(zip, radius) {
  const json = await tgtGet("nearby_stores_v1", { limit: "20", within: radius, place: zip, page: "/" });
  return (json?.data?.nearby_stores?.stores || []).map((s) => ({
    storeId: String(s.store_id),
    name: s.location_name || `Target #${s.store_id}`,
    city: s.mailing_address?.city || "",
    distance: typeof s.distance === "number" ? s.distance : null,
  }));
}

async function searchStore(storeId, keyword, offset) {
  const json = await tgtGet("plp_search_v2", {
    count: "24", default_purchasability_filter: "true", include_sponsored: "false",
    keyword, offset: String(offset), page: `/s/${keyword}`, platform: "mobile",
    pricing_store_id: storeId, store_ids: storeId, visitor_id: visitorId,
  });
  return json?.data?.search?.products || [];
}

function DealCard({ item }) {
  const [open, setOpen] = useState(false);
  const stores = item.stores || [];
  const shown = open ? stores : stores.slice(0, 2);
  const off = item.regular ? Math.round((1 - item.bestPrice / item.regular) * 100) : null;
  return (
    <Pressable style={styles.card} onPress={() => setOpen(!open)}>
      <View style={styles.cardRow}>
        {item.image ? <Image source={{ uri: item.image }} style={styles.thumb} /> : <View style={styles.thumb} />}
        <View style={styles.fill}>
          <Text style={styles.title} numberOfLines={open ? 4 : 2}>{item.title}</Text>
          <View style={styles.priceRow}>
            <View style={styles.priceTag}>
              <Text style={styles.priceText}>${item.bestPrice.toFixed(2)}</Text>
            </View>
            {item.regular ? <Text style={styles.was}>${Number(item.regular).toFixed(2)}</Text> : null}
            {off !== null && off > 0 ? <Text style={styles.off}>{off}% off</Text> : null}
          </View>
        </View>
      </View>
      {shown.map((s) => (
        <View key={s.storeId} style={styles.storeRow}>
          <Text style={styles.storeName} numberOfLines={1}>{s.name}{s.city ? `, ${s.city}` : ""}</Text>
          <Text style={styles.storePrice}>${s.price.toFixed(2)}</Text>
        </View>
      ))}
      {!open && stores.length > 2 && (
        <Text style={styles.more}>{stores.length - 2} more stores — tap to show</Text>
      )}
      {open && (
        <Pressable style={styles.openBtn} onPress={() => Linking.openURL(item.url)}>
          <Text style={styles.openText}>Open on Target</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

function TargetTab({ visible }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState(DEFAULT_SETTINGS);
  const [stores, setStores] = useState([]);
  const [results, setResults] = useState(null); // { updated, items }
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("price");
  const [showSettings, setShowSettings] = useState(false);
  const [finding, setFinding] = useState(false);
  const stopRef = useRef(false);

  // Load saved settings, stores and last results
  useEffect(() => {
    (async () => {
      try {
        const [s, st, r] = await Promise.all([
          AsyncStorage.getItem("tgt_settings"), AsyncStorage.getItem("tgt_stores"), AsyncStorage.getItem("tgt_results"),
        ]);
        if (s) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(s) });
        if (st) setStores(JSON.parse(st));
        if (r) setResults(JSON.parse(r));
      } catch {}
    })();
  }, []);

  const openSettings = () => { setDraft(settings); setShowSettings(true); };

  const lookupStores = async () => {
    setFinding(true);
    setError("");
    try {
      const found = await findStores(draft.zip.trim(), draft.radius.trim() || "15");
      found.sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));
      setStores(found);
      setDraft({ ...draft, selected: found.slice(0, 5).map((s) => s.storeId) });
      try { await AsyncStorage.setItem("tgt_stores", JSON.stringify(found)); } catch {}
    } catch (e) {
      setError(`Couldn't find stores (${e.message}). Check the ZIP and try again.`);
    }
    setFinding(false);
  };

  const toggleStore = (id) => {
    const sel = draft.selected.includes(id) ? draft.selected.filter((x) => x !== id) : [...draft.selected, id];
    setDraft({ ...draft, selected: sel });
  };

  const saveSettings = async () => {
    setSettings(draft);
    try { await AsyncStorage.setItem("tgt_settings", JSON.stringify(draft)); } catch {}
    setShowSettings(false);
  };

  const scan = async () => {
    const chosen = stores.filter((s) => settings.selected.includes(s.storeId));
    if (!chosen.length) { openSettings(); return; }
    const maxPrice = parseFloat(settings.maxPrice) || 5;
    const minOff = parseFloat(settings.minOff) || 70;
    stopRef.current = false;
    setScanning(true);
    setError("");
    const items = new Map();
    let blocked = 0;
    let ok = 0;

    for (const [si, store] of chosen.entries()) {
      for (const [keyword, pages] of SEARCHES) {
        for (let page = 0; page < pages; page++) {
          if (stopRef.current) break;
          setProgress(`Store ${si + 1} of ${chosen.length}: ${store.name} · ${keyword}`);
          let products = [];
          try {
            products = await searchStore(store.storeId, keyword, page * 24);
            ok++;
          } catch (e) {
            blocked++;
            await sleep(1500);
            break;
          }
          if (!products.length) break;
          for (const p of products) {
            const price = p.price || {};
            const current = price.current_retail ?? price.current_retail_min;
            const regular = price.reg_retail ?? price.reg_retail_max ?? current;
            if (typeof current !== "number") continue;
            const pctOff = regular > 0 ? Math.round((1 - current / regular) * 100) : 0;
            if (!(current <= maxPrice || pctOff >= minOff)) continue;
            if (!items.has(p.tcin)) {
              items.set(p.tcin, {
                chain: "Target", id: p.tcin,
                title: (p.item?.product_description?.title || "Unknown item").replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
                url: p.item?.enrichment?.buy_url || `https://www.target.com/p/-/A-${p.tcin}`,
                image: p.item?.enrichment?.images?.primary_image_url || "",
                regular, stores: [],
              });
            }
            const it = items.get(p.tcin);
            if (!it.stores.some((s) => s.storeId === store.storeId)) it.stores.push({ ...store, price: current });
          }
          await sleep(700);
        }
      }
    }

    const list = [...items.values()].map((it) => ({
      ...it,
      stores: it.stores.sort((a, b) => a.price - b.price),
      bestPrice: Math.min(...it.stores.map((s) => s.price)),
    }));
    if (ok === 0 && blocked > 0) {
      setError("Target turned down every request. Try again on Wi-Fi or mobile data in a few minutes.");
    } else {
      const saved = { updated: new Date().toISOString(), storeCount: chosen.length, items: list };
      setResults(saved);
      try { await AsyncStorage.setItem("tgt_results", JSON.stringify(saved)); } catch {}
    }
    setProgress("");
    setScanning(false);
  };

  const list = useMemo(() => {
    const all = results?.items || [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter((d) => d.title.toLowerCase().includes(q) || d.stores?.some((s) => `${s.name} ${s.city}`.toLowerCase().includes(q)))
      : all;
    const pct = (d) => (d.regular ? 1 - d.bestPrice / d.regular : 0);
    return [...filtered].sort((a, b) =>
      sort === "price" ? a.bestPrice - b.bestPrice
      : sort === "off" ? pct(b) - pct(a)
      : (b.stores?.length || 0) - (a.stores?.length || 0));
  }, [results, query, sort]);

  const selectedCount = settings.selected.length;

  return (
    <View style={[styles.fill, !visible && styles.hidden]}>
      <View style={styles.searchRow}>
        <TextInput style={styles.search} placeholder="Search items or stores" placeholderTextColor={C.muted}
          value={query} onChangeText={setQuery} />
        <Pressable style={styles.iconBtn} onPress={openSettings}>
          <Text style={styles.iconText}>⚙</Text>
        </Pressable>
      </View>

      <View style={styles.scanRow}>
        {scanning ? (
          <>
            <View style={styles.fill}>
              <Text style={styles.progress} numberOfLines={1}>{progress}</Text>
            </View>
            <Pressable style={styles.stopBtn} onPress={() => { stopRef.current = true; }}>
              <Text style={styles.stopText}>Stop</Text>
            </Pressable>
          </>
        ) : (
          <Pressable style={styles.scanBtn} onPress={scan}>
            <Text style={styles.scanText}>
              {selectedCount ? `Scan ${selectedCount} store${selectedCount > 1 ? "s" : ""} now` : "Pick your stores"}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={styles.sortRow}>
        {[["price", "Cheapest"], ["off", "Most off"], ["stores", "Most stores"]].map(([k, label]) => (
          <Pressable key={k} onPress={() => setSort(k)} style={[styles.chip, sort === k && styles.chipOn]}>
            <Text style={[styles.chipText, sort === k && styles.chipTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {results?.updated && (
        <Text style={styles.meta}>
          {list.length} items · {results.storeCount} stores · scanned {new Date(results.updated).toLocaleString()}
        </Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={list}
        keyExtractor={(d) => `${d.chain}-${d.id}`}
        renderItem={({ item }) => <DealCard item={item} />}
        contentContainerStyle={styles.listPad}
        ListEmptyComponent={!scanning ? (
          <Text style={styles.empty}>
            {selectedCount
              ? "Tap Scan to check your stores' clearance. It takes about a minute per store."
              : "Tap ⚙, enter your ZIP, find stores, and pick the ones you shop at."}
          </Text>
        ) : null}
      />

      <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
        <View style={styles.modalBg}>
          <View style={[styles.modal, styles.modalTall]}>
            <Text style={styles.modalTitle}>Your Target stores</Text>
            <View style={styles.inlineRow}>
              <TextInput style={[styles.search, styles.fill]} value={draft.zip} keyboardType="number-pad" maxLength={5}
                onChangeText={(t) => setDraft({ ...draft, zip: t })} placeholder="ZIP" placeholderTextColor={C.muted} />
              <TextInput style={[styles.search, styles.small]} value={draft.radius} keyboardType="number-pad"
                onChangeText={(t) => setDraft({ ...draft, radius: t })} placeholder="mi" placeholderTextColor={C.muted} />
              <Pressable onPress={lookupStores} style={[styles.chip, styles.chipOn]}>
                <Text style={styles.chipTextOn}>{finding ? "…" : "Find"}</Text>
              </Pressable>
            </View>
            <Text style={styles.modalHelp}>Fewer stores scan faster. Tap a store to add or remove it.</Text>
            <FlatList
              style={styles.storeList}
              data={stores}
              keyExtractor={(s) => s.storeId}
              renderItem={({ item: s }) => {
                const on = draft.selected.includes(s.storeId);
                return (
                  <Pressable onPress={() => toggleStore(s.storeId)} style={styles.pickRow}>
                    <View style={[styles.box, on && styles.boxOn]} />
                    <Text style={styles.storeName} numberOfLines={1}>
                      {s.name}{s.city ? `, ${s.city}` : ""}{s.distance != null ? ` · ${s.distance.toFixed(1)} mi` : ""}
                    </Text>
                  </Pressable>
                );
              }}
              ListEmptyComponent={<Text style={styles.modalHelp}>No stores yet. Enter a ZIP and tap Find.</Text>}
            />
            <Text style={styles.modalHelp}>Show items at or under this price, or at least this % off:</Text>
            <View style={styles.inlineRow}>
              <Text style={styles.label}>$</Text>
              <TextInput style={[styles.search, styles.small]} value={draft.maxPrice} keyboardType="decimal-pad"
                onChangeText={(t) => setDraft({ ...draft, maxPrice: t })} />
              <TextInput style={[styles.search, styles.small]} value={draft.minOff} keyboardType="number-pad"
                onChangeText={(t) => setDraft({ ...draft, minOff: t })} />
              <Text style={styles.label}>% off</Text>
            </View>
            <View style={styles.modalBtns}>
              <Pressable onPress={() => setShowSettings(false)} style={styles.chip}><Text style={styles.chipText}>Cancel</Text></Pressable>
              <Pressable onPress={saveSettings} style={[styles.chip, styles.chipOn]}><Text style={styles.chipTextOn}>Save</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ---------------- Shell ----------------
function Main() {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState("penny");
  const webRefs = { penny: useRef(null), clearance: useRef(null) };
  const canBack = useRef({ penny: false, clearance: false });

  // Android back button goes back inside the web pages first
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (webRefs[tab] && canBack.current[tab]) { webRefs[tab].current?.goBack(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [tab]);

  const current = TABS.find((t) => t.key === tab);

  return (
    <View style={[styles.fill, { backgroundColor: C.bg, paddingTop: insets.top }]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.brand}>Markdown</Text>
        {current.url && (
          <Pressable style={styles.iconBtn} onPress={() => webRefs[tab].current?.reload()}>
            <Text style={styles.iconText}>↻</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.fill}>
        {TABS.filter((t) => t.url).map((t) => (
          <WebTab key={t.key} url={t.url} visible={tab === t.key} webRef={webRefs[t.key]}
            onNav={(s) => { canBack.current[t.key] = s.canGoBack; }} />
        ))}
        <TargetTab visible={tab === "target"} />
      </View>

      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TABS.map((t) => {
          const on = tab === t.key;
          const dot = t.key === "target" ? C.target : C.depot;
          return (
            <Pressable key={t.key} style={styles.tabBtn} onPress={() => setTab(t.key)}>
              <View style={[styles.tabDot, { backgroundColor: on ? dot : "transparent", borderColor: dot }]} />
              <Text style={[styles.tabText, on && styles.tabTextOn]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hidden: { display: "none" },
  web: { flex: 1, backgroundColor: C.bg },
  loader: { position: "absolute", top: 12, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  brand: { flex: 1, color: C.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: C.panel },
  iconText: { color: C.text, fontSize: 18 },
  tabBar: { flexDirection: "row", borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.bg, paddingTop: 8 },
  tabBtn: { flex: 1, alignItems: "center", gap: 4, paddingVertical: 4 },
  tabDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  tabText: { color: C.muted, fontSize: 13, fontWeight: "600" },
  tabTextOn: { color: C.text },
  searchRow: { flexDirection: "row", gap: 8, padding: 12, paddingBottom: 6 },
  search: { flex: 1, backgroundColor: C.panel, color: C.text, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15 },
  sortRow: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingBottom: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: C.line },
  chipOn: { backgroundColor: C.tag, borderColor: C.tag },
  chipText: { color: C.muted, fontWeight: "600", fontSize: 13 },
  chipTextOn: { color: C.tagInk, fontWeight: "700", fontSize: 13 },
  meta: { color: C.muted, fontSize: 12, paddingHorizontal: 14, paddingBottom: 4 },
  error: { color: "#FF8A80", paddingHorizontal: 14, paddingVertical: 6 },
  empty: { color: C.muted, textAlign: "center", padding: 32, lineHeight: 21 },
  listPad: { padding: 12, paddingTop: 4, gap: 10 },
  card: { backgroundColor: C.panel, borderRadius: 12, padding: 12, borderLeftWidth: 4, borderLeftColor: C.target },
  cardRow: { flexDirection: "row", gap: 12, marginBottom: 6 },
  thumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: "#FFFFFF" },
  title: { color: C.text, fontSize: 14, lineHeight: 19 },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  priceTag: { backgroundColor: C.tag, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 3 },
  priceText: { color: C.tagInk, fontSize: 18, fontWeight: "900" },
  was: { color: C.muted, textDecorationLine: "line-through", fontSize: 13 },
  off: { color: C.tag, fontSize: 13, fontWeight: "700" },
  storeRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.line },
  storeName: { color: C.text, fontSize: 13, flex: 1, marginRight: 8 },
  storePrice: { color: C.tag, fontSize: 13, fontWeight: "700" },
  more: { color: C.muted, fontSize: 12, marginTop: 4 },
  openBtn: { marginTop: 8, backgroundColor: C.target, borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  openText: { color: "#FFFFFF", fontWeight: "700" },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: C.bg, borderRadius: 14, padding: 18, gap: 10 },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: "800" },
  modalHelp: { color: C.muted, fontSize: 13 },
  modalTall: { maxHeight: "85%" },
  storeList: { maxHeight: 260 },
  inlineRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  small: { flex: 0, width: 72 },
  label: { color: C.text, fontSize: 15 },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  box: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: C.muted },
  boxOn: { backgroundColor: C.tag, borderColor: C.tag },
  scanRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  scanBtn: { flex: 1, backgroundColor: C.tag, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  scanText: { color: C.tagInk, fontWeight: "800", fontSize: 15 },
  progress: { color: C.text, fontSize: 13 },
  stopBtn: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16 },
  stopText: { color: C.text, fontWeight: "700" },
  modalBtns: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
});
