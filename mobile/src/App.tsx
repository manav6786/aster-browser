import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, AppState, BackHandler, Easing, Keyboard,
  Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { WebViewNavigation } from 'react-native-webview';
import { closeTab, MAX_TABS, newSession, newTab, resolveAddress, restoreSession, saveSession, webURL } from './session';
import type { Session, Tab } from './session';

const STORAGE_KEY = 'aster-session-v1';
const INK = '#090810';
const PANEL = '#181622';
const LINE = '#302b42';
const WHITE = '#faf7ff';
const QUIET = '#b2a9c1';
const ACCENT = '#ccb7ff';
const shortcuts = [
  { title: 'Apple', initials: 'A', color: '#dcc2ff', url: 'https://www.apple.com/' },
  { title: 'GitHub', initials: 'G', color: '#a6e3db', url: 'https://github.com/' },
  { title: 'Wikipedia', initials: 'W', color: '#f8ceb3', url: 'https://www.wikipedia.org/' },
];

function Control({ glyph, label, onPress, disabled = false }: {
  glyph: string; label: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.control, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={styles.controlText}>{glyph}</Text>
    </Pressable>
  );
}

function Orbit() {
  const lift = useRef(new Animated.Value(0)).current;
  const [reduced, setReduced] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduced(value); });
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    const visibility = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => { mounted = false; motion.remove(); visibility.remove(); };
  }, []);

  useEffect(() => {
    if (reduced || !foreground) { lift.setValue(0); return; }
    const motion = Animated.loop(Animated.sequence([
      Animated.timing(lift, { toValue: -12, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(lift, { toValue: 0, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    motion.start();
    return () => motion.stop();
  }, [foreground, lift, reduced]);

  return (
    <Animated.View style={[styles.orb, { transform: [{ translateY: lift }] }]}>
      <Image accessible={false} source={require('../assets/orb.png')} resizeMode="contain" style={styles.orbImage} />
    </Animated.View>
  );
}

function Home({ open }: { open: (url: string) => void }) {
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.home}>
      <Orbit />
      <View style={styles.shortcuts}>
        {shortcuts.map(({ title, url, color, initials }) => (
          <Pressable key={url} onPress={() => open(url)} accessibilityRole="link" accessibilityLabel={title} style={({ pressed }) => [styles.shortcut, pressed && styles.pressed]}>
            <View style={styles.shortcutIcon}><Text style={[styles.shortcutLetter, { color }]}>{initials}</Text></View>
            <Text numberOfLines={1} style={styles.shortcutText}>{title}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function TabOverview({ session, add, close, select, dismiss }: {
  session: Session; add: () => void; close: (id: string) => void; select: (id: string) => void; dismiss: () => void;
}) {
  const full = session.tabs.length === MAX_TABS;
  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={dismiss}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.overviewHeader}>
          <Text accessibilityRole="header" style={styles.heading}>Tabs</Text>
          <Control glyph="×" label="Done" onPress={dismiss} />
        </View>
        <ScrollView contentContainerStyle={styles.tabList}>
          {session.tabs.map(tab => (
            <View key={tab.id} style={[styles.tabRow, tab.id === session.activeId && styles.selectedRow]}>
              <Pressable onPress={() => select(tab.id)} accessibilityRole="button" accessibilityState={{ selected: tab.id === session.activeId }} style={styles.tabEntry}>
                <Text numberOfLines={1} style={styles.tabTitle}>{tab.title}</Text>
                {tab.url && <Text numberOfLines={1} style={styles.tabHost}>{new URL(tab.url).hostname}</Text>}
              </Pressable>
              <Control glyph="×" label={`Close ${tab.title}`} onPress={() => close(tab.id)} />
            </View>
          ))}
          <Pressable onPress={add} disabled={full} accessibilityRole="button" accessibilityState={{ disabled: full }} style={[styles.newTab, full && styles.disabled]}>
            <Text style={styles.newTabLabel}>{full ? `${MAX_TABS} tabs open` : '＋  New tab'}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Browser() {
  const [session, setSession] = useState(newSession);
  const [ready, setReady] = useState(false);
  const [overview, setOverview] = useState(false);
  const [visited, setVisited] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const views = useRef(new Map<string, Pick<WebView, 'goBack' | 'goForward' | 'reload' | 'stopLoading'>>());
  const active = session.tabs.find(tab => tab.id === session.activeId) ?? session.tabs[0];
  const persisted = saveSession(session);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (mounted) setSession(restoreSession(raw));
    }).catch(() => { if (mounted) setStorageError(true); }).finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (ready && !storageError) void AsyncStorage.setItem(STORAGE_KEY, persisted).catch(() => setStorageError(true));
  }, [ready, persisted, storageError]);

  useEffect(() => {
    if (active.source) setVisited(ids => ids.includes(active.id) ? ids : [...ids, active.id]);
  }, [active.id, active.source]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const view = views.current.get(active.id);
      if (!active.canGoBack || !view) return false;
      view.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [active.id, active.canGoBack]);

  function update(id: string, change: Partial<Tab>) {
    setSession(previous => ({ ...previous, tabs: previous.tabs.map(tab => tab.id === id ? { ...tab, ...change } : tab) }));
  }

  function open(url: string) {
    const next = webURL(url);
    if (!next) return;
    setDraft(null);
    setAddressError(null);
    Keyboard.dismiss();
    if (active.source === next && active.url === next && !active.needsReload) {
      views.current.get(active.id)?.reload();
      return;
    }
    // Replacing a WebView is necessary if the requested address is already
    // its source prop but a link led elsewhere inside that native view.
    const replaceView = active.source === next;
    update(active.id, {
      source: next, url: next, title: new URL(next).hostname, loading: true, needsReload: false,
      ...(replaceView && { revision: active.revision + 1, canGoBack: false, canGoForward: false }),
    });
  }

  function submitAddress(value: string) {
    const next = resolveAddress(value);
    if (next) open(next);
    else setAddressError('Enter an HTTPS address or search words.');
  }

  function add(url: string | null = null) {
    const tab = newTab(url, url ? new URL(url).hostname : 'New tab');
    setSession(previous => previous.tabs.length >= MAX_TABS ? previous : { tabs: [...previous.tabs, tab], activeId: tab.id });
    setDraft(null);
    setAddressError(null);
    setOverview(false);
  }

  function navigation(id: string, state: WebViewNavigation) {
    const url = webURL(state.url);
    if (!url) return;
    update(id, {
      url, title: state.title?.trim().slice(0, 160) || new URL(url).hostname,
      canGoBack: state.canGoBack, canGoForward: state.canGoForward, loading: state.loading,
    });
  }

  function reload() {
    if (active.needsReload) {
      update(active.id, { source: active.url ?? active.source, needsReload: false, loading: true });
    } else if (active.loading) {
      views.current.get(active.id)?.stopLoading();
      update(active.id, { loading: false });
    } else {
      views.current.get(active.id)?.reload();
    }
  }

  if (!ready) return <SafeAreaView style={[styles.screen, styles.center]}><ActivityIndicator color={ACCENT} accessibilityLabel="Opening Aster" /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.wordmark} accessibilityLabel="Aster">✳ <Text style={styles.brand}>aster.</Text></Text>
        <TextInput
          value={draft ?? active.url ?? ''}
          placeholder="Search or enter address"
          accessibilityLabel="Search or enter address"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          selectTextOnFocus
          returnKeyType="go"
          maxLength={2048}
          placeholderTextColor={QUIET}
          onChangeText={value => { setDraft(value); setAddressError(null); }}
          onSubmitEditing={event => submitAddress(event.nativeEvent.text)}
          style={styles.address}
        />
        {(addressError || storageError) && <Text accessibilityLiveRegion="polite" style={styles.notice}>{addressError || 'Session storage is unavailable.'}</Text>}
      </View>
      <View style={styles.content}>
        {!active.source && <Home open={open} />}
        {session.tabs.map(tab => {
          const visible = active.id === tab.id;
          if (!tab.source || tab.needsReload || (!visible && !visited.includes(tab.id))) return null;
          return (
            <View key={tab.id} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'} style={[StyleSheet.absoluteFill, !visible && styles.hidden]}>
              <WebView
                key={tab.revision}
                ref={view => { if (view) views.current.set(tab.id, view); else views.current.delete(tab.id); }}
                source={{ uri: tab.source }}
                originWhitelist={['*']}
                onShouldStartLoadWithRequest={({ url }) => url === 'about:blank' || webURL(url) !== null}
                onNavigationStateChange={state => navigation(tab.id, state)}
                onOpenWindow={({ nativeEvent }) => {
                  const url = webURL(nativeEvent.targetUrl);
                  if (visible && url) {
                    if (session.tabs.length >= MAX_TABS) setAddressError('Close a tab to open another.');
                    else add(url);
                  }
                }}
                onError={() => update(tab.id, { loading: false, needsReload: true })}
                onContentProcessDidTerminate={() => update(tab.id, { loading: false, needsReload: true })}
                onRenderProcessGone={() => update(tab.id, { loading: false, needsReload: true })}
                allowFileAccess={false}
                allowFileAccessFromFileURLs={false}
                allowUniversalAccessFromFileURLs={false}
                mixedContentMode="never"
                thirdPartyCookiesEnabled={false}
                geolocationEnabled={false}
                javaScriptCanOpenWindowsAutomatically={false}
                allowsInlineMediaPlayback
                allowsFullscreenVideo
                allowsBackForwardNavigationGestures
                style={styles.webView}
              />
            </View>
          );
        })}
        {active.needsReload && <View style={[styles.content, styles.center]}>
          <Text style={styles.tabTitle}>This page couldn’t load</Text>
          <Pressable onPress={reload} accessibilityRole="button" style={styles.retry}><Text style={styles.newTabLabel}>Try again</Text></Pressable>
        </View>}
      </View>
      <View style={styles.toolbar}>
        <Control glyph="‹" label="Back" disabled={!active.canGoBack || active.needsReload} onPress={() => views.current.get(active.id)?.goBack()} />
        <Control glyph="›" label="Forward" disabled={!active.canGoForward || active.needsReload} onPress={() => views.current.get(active.id)?.goForward()} />
        <Control glyph={active.loading ? '×' : '↻'} label={active.loading ? 'Stop loading' : 'Reload'} disabled={!active.source} onPress={reload} />
        <Control glyph={`${session.tabs.length}`} label={`Tab overview, ${session.tabs.length} open`} onPress={() => { Keyboard.dismiss(); setOverview(true); }} />
        <Control glyph="＋" label="New tab" disabled={session.tabs.length >= MAX_TABS} onPress={() => add()} />
      </View>
      {overview && <TabOverview session={session} add={() => add()} close={id => {
        setSession(previous => closeTab(previous, id));
        setVisited(ids => ids.filter(current => current !== id));
        setDraft(null);
        setAddressError(null);
      }} select={id => {
        setSession(previous => ({ ...previous, activeId: id }));
        setDraft(null);
        setAddressError(null);
        setOverview(false);
      }} dismiss={() => setOverview(false)} />}
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><Browser /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: INK },
  header: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: LINE },
  wordmark: { fontSize: 23, fontWeight: '700', color: ACCENT, letterSpacing: -0.7 },
  brand: { color: WHITE },
  address: { minHeight: 48, backgroundColor: PANEL, borderColor: LINE, borderWidth: 1, borderRadius: 16, paddingHorizontal: 15, paddingVertical: 8, fontSize: 16, color: WHITE },
  notice: { color: '#ffcbbd', fontSize: 13 },
  content: { flex: 1, backgroundColor: INK },
  center: { alignItems: 'center', justifyContent: 'center', gap: 18 },
  home: { flexGrow: 1, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 28 },
  orb: { width: '88%', maxWidth: 360, aspectRatio: 1 },
  orbImage: { width: '100%', height: '100%' },
  shortcuts: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 14 },
  shortcut: { width: 82, alignItems: 'center', gap: 8, borderRadius: 14, padding: 5 },
  shortcutIcon: { width: 52, height: 52, borderRadius: 17, backgroundColor: PANEL, borderWidth: 1, borderColor: LINE, alignItems: 'center', justifyContent: 'center' },
  shortcutLetter: { fontSize: 21, fontWeight: '600' },
  shortcutText: { color: QUIET, fontSize: 12 },
  hidden: { display: 'none' },
  webView: { flex: 1, backgroundColor: INK },
  toolbar: { paddingHorizontal: 18, paddingVertical: 8, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderColor: LINE },
  control: { alignItems: 'center', justifyContent: 'center', minWidth: 46, minHeight: 46, paddingHorizontal: 6, borderRadius: 13 },
  controlText: { color: ACCENT, fontSize: 24, fontWeight: '600' },
  pressed: { backgroundColor: '#2b223d' },
  disabled: { opacity: 0.42 },
  overviewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 16 },
  heading: { fontSize: 34, color: WHITE, fontWeight: '700', letterSpacing: -1.4 },
  tabList: { padding: 20, gap: 12 },
  tabRow: { flexDirection: 'row', alignItems: 'center', padding: 6, backgroundColor: PANEL, borderColor: LINE, borderWidth: 1, borderRadius: 16 },
  selectedRow: { borderColor: '#8362c5', backgroundColor: '#231b34' },
  tabEntry: { flex: 1, padding: 10, gap: 5 },
  tabTitle: { color: WHITE, fontSize: 16, fontWeight: '600' },
  tabHost: { color: QUIET, fontSize: 13 },
  newTab: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: '#251c39' },
  retry: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 14, backgroundColor: '#251c39' },
  newTabLabel: { color: ACCENT, fontSize: 15, fontWeight: '600' },
});
