import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, Image, Linking, BackHandler,
  RefreshControl, Modal, StyleSheet, ActivityIndicator,
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

const DEFAULT_DEALS_URL =
  "https://raw.githubusercontent.com/Jupiter-Coder4599/deal-scanner/main/deals.json";

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

// ---------------- Target deals (from your GitHub scanner) ----------------
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
  const [url, setUrl] = useState(DEFAULT_DEALS_URL);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("price"); // price | off | stores
  const [settings, setSettings] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");

  const load = useCallback(async (u) => {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch(`${u}?t=${Date.now()}`); // skip cache
      if (!res.ok) throw new Error(`Couldn't load deals (HTTP ${res.status}). Check the link in settings.`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message.includes("HTTP") ? e.message : "Couldn't reach the deals file. Check your connection or the link in settings.");
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    (async () => {
      let saved = null;
      try { saved = await AsyncStorage.getItem("dealsUrl"); } catch {}
      const u = saved || DEFAULT_DEALS_URL;
      setUrl(u);
      load(u);
    })();
  }, [load]);

  const list = useMemo(() => {
    const all = (data?.deals || []).filter((d) => d.chain === "Target" && typeof d.bestPrice === "number");
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter((d) => d.title.toLowerCase().includes(q) || d.stores?.some((s) => `${s.name} ${s.city}`.toLowerCase().includes(q)))
      : all;
    const pct = (d) => (d.regular ? 1 - d.bestPrice / d.regular : 0);
    return [...filtered].sort((a, b) =>
      sort === "price" ? a.bestPrice - b.bestPrice
      : sort === "off" ? pct(b) - pct(a)
      : (b.stores?.length || 0) - (a.stores?.length || 0));
  }, [data, query, sort]);

  const saveUrl = async () => {
    const u = draftUrl.trim();
    if (!u) return;
    try { await AsyncStorage.setItem("dealsUrl", u); } catch {}
    setUrl(u);
    setSettings(false);
    load(u);
  };

  const updated = data?.updated ? new Date(data.updated).toLocaleString() : null;

  return (
    <View style={[styles.fill, !visible && styles.hidden]}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.search}
          placeholder="Search items or stores"
          placeholderTextColor={C.muted}
          value={query}
          onChangeText={setQuery}
        />
        <Pressable style={styles.iconBtn} onPress={() => { setDraftUrl(url); setSettings(true); }}>
          <Text style={styles.iconText}>⚙</Text>
        </Pressable>
      </View>
      <View style={styles.sortRow}>
        {[["price", "Cheapest"], ["off", "Most off"], ["stores", "Most stores"]].map(([k, label]) => (
          <Pressable key={k} onPress={() => setSort(k)} style={[styles.chip, sort === k && styles.chipOn]}>
            <Text style={[styles.chipText, sort === k && styles.chipTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {updated && <Text style={styles.meta}>{list.length} items · scanned {updated}</Text>}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={list}
        keyExtractor={(d) => `${d.chain}-${d.id}`}
        renderItem={({ item }) => <DealCard item={item} />}
        contentContainerStyle={styles.listPad}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(url)} tintColor={C.tag} colors={[C.tag]} />}
        ListEmptyComponent={!refreshing && !error ? (
          <Text style={styles.empty}>
            No Target deals yet. Run "Scan for deals" in your GitHub repo's Actions tab, then pull down here to refresh.
          </Text>
        ) : null}
      />
      <Modal visible={settings} transparent animationType="fade" onRequestClose={() => setSettings(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Deals file link</Text>
            <Text style={styles.modalHelp}>The raw link to deals.json in your deal-scanner repo.</Text>
            <TextInput style={styles.search} value={draftUrl} onChangeText={setDraftUrl} autoCapitalize="none" autoCorrect={false} />
            <View style={styles.modalBtns}>
              <Pressable onPress={() => setSettings(false)} style={styles.chip}><Text style={styles.chipText}>Cancel</Text></Pressable>
              <Pressable onPress={saveUrl} style={[styles.chip, styles.chipOn]}><Text style={styles.chipTextOn}>Save link</Text></Pressable>
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
  modalBtns: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
});
