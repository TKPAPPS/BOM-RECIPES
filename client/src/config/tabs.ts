// Single source of truth for the sidebar tabs and their per-role
// default visibility.  Mirrors the keys in src/routes/rolePermissions.js.

export type TabKey =
  | 'dashboard' | 'book' | 'kitchen' | 'test'
  | 'pending' | 'whereused' | 'products' | 'settings' | 'logs' | 'profile';

export type Role = 'customer' | 'admin' | 'manager';

export interface TabDef {
  key: TabKey;
  path: string;       // primary route for this tab
  labelKey: string;   // key into the translation table (t[labelKey])
  alwaysOn?: boolean;  // always visible to every role; not in the permission matrix
}

// Order here = order in the sidebar AND the order used to pick a
// landing tab when the user's current one is not permitted.
export const TABS: TabDef[] = [
  { key: 'dashboard', path: '/dashboard',       labelKey: 'dashboard' },
  { key: 'book',      path: '/book',            labelKey: 'recipeBook' },
  { key: 'kitchen',   path: '/kitchen',         labelKey: 'kitchenRecipes' },
  { key: 'test',      path: '/test-kitchen',    labelKey: 'testRecipes' },
  { key: 'pending',   path: '/pending-recipes', labelKey: 'pendingApproval' },
  { key: 'whereused', path: '/where-used',      labelKey: 'whereUsed' },
  { key: 'products',  path: '/products',        labelKey: 'products' },
  { key: 'settings',  path: '/settings',        labelKey: 'settings' },
  { key: 'logs',      path: '/logs',            labelKey: 'logs' },
  // Personal area — configurable per role (on by default for everyone).
  { key: 'profile',   path: '/profile',         labelKey: 'profileTab' },
];

/** Tabs that every role always sees (not part of the permission matrix). */
export const ALWAYS_ON_TABS: TabKey[] = TABS.filter((t) => t.alwaysOn).map((t) => t.key);

export const ALL_TAB_KEYS: TabKey[] = TABS.map((t) => t.key);

/** Historical default visibility per role (used while loading / as fallback). */
export function defaultTabsFor(role: Role): TabKey[] {
  if (role === 'manager') return [...ALL_TAB_KEYS];
  if (role === 'admin') return ['book', 'test', 'products', 'profile'];
  return ['book', 'profile']; // customer
}

/** First permitted tab's path (sidebar order), or null if none. */
export function firstAllowedPath(allowed: Set<string>): string | null {
  const tab = TABS.find((t) => allowed.has(t.key));
  return tab ? tab.path : null;
}
