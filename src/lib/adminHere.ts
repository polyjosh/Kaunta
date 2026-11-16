/**
 * Which owner or manager is signed in to admin on this browser, and in which
 * bar. The counter on the same browser lets them straight in ("toggle without
 * signing in again"). Cleared when they sign out of admin.
 */
export interface AdminHere {
  bar_id: string;
  person_id: string;
}

const KEY = 'kaunta.adminHere';

export function adminHere(): AdminHere | null {
  try {
    const raw = localStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as AdminHere) : null;
    return value && typeof value.bar_id === 'string' && typeof value.person_id === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function setAdminHere(value: AdminHere | null): void {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered: the counter asks for their password or PIN.
  }
}
