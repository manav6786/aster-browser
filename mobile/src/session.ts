export const MAX_TABS = 8;

export type Tab = {
  id: string;
  url: string | null;
  title: string;
  source: string | null;
  revision: number;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  needsReload: boolean;
};

export type Session = { tabs: Tab[]; activeId: string };

export function webURL(value: string): string | null {
  if (value.length > 8192 || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function resolveAddress(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2048) return null;
  if (/^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#].*)?$/iu.test(value)) {
    return webURL(`https://${value}`);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return webURL(value);
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function newTab(url: string | null = null, title = 'New tab', id = uniqueId()): Tab {
  return { id, url, title, source: url, revision: 0, canGoBack: false, canGoForward: false, loading: !!url, needsReload: false };
}

function uniqueId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function newSession(): Session {
  const tab = newTab();
  return { tabs: [tab], activeId: tab.id };
}

export function closeTab(session: Session, id: string): Session {
  const index = session.tabs.findIndex(tab => tab.id === id);
  if (index === -1) return session;
  const tabs = session.tabs.filter(tab => tab.id !== id);
  if (!tabs.length) return newSession();
  const activeId = id === session.activeId ? tabs[Math.min(index, tabs.length - 1)].id : session.activeId;
  return { tabs, activeId };
}

export function saveSession({ tabs, activeId }: Session): string {
  return JSON.stringify({ tabs: tabs.map(({ id, url, title }) => ({ id, url, title })), activeId });
}

export function restoreSession(raw: string | null): Session {
  try {
    const saved = JSON.parse(raw ?? 'null');
    if (!Array.isArray(saved?.tabs)) return newSession();
    const tabs: Tab[] = [];
    const seen = new Set<string>();
    for (const item of saved.tabs.slice(0, MAX_TABS)) {
      if (typeof item?.id !== 'string' || !item.id || item.id.length > 100 || seen.has(item.id)) continue;
      const url = typeof item.url === 'string' ? webURL(item.url) : null;
      const title = url && typeof item.title === 'string' ? item.title.slice(0, 160) : 'New tab';
      tabs.push(newTab(url, title, item.id));
      seen.add(item.id);
    }
    if (tabs.length) return { tabs, activeId: seen.has(saved.activeId) ? saved.activeId : tabs[0].id };
  } catch {
    // A corrupt save should fall back to a usable home tab.
  }
  return newSession();
}
