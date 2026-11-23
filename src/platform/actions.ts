import type { AdminEvent } from '../data/adminEvents';
import { KAUNTA_ACTOR, recordAdminEvent } from '../data/adminEvents';
import type { KauntaDB } from '../data/db';
import { uuidv7 } from '../domain/ids';
import { hashSecret } from '../domain/pin';
import type { AdminServer } from '../admin/server';
import { demoStore, managerAdded, managerRemoved, syncAccountPeople } from '../admin/bars';
import * as demo from './platform';
import { refreshSnapshots } from './superData';
import type { Account, AccountProblem, CodeProblem, ManagerProblem, NewPerson, PasswordProblem, PlatformBar } from './platform';

/**
 * Every change to the platform, whichever way Kaunta runs: in the browser demo
 * (src/platform/platform.ts, browser storage) or on the server (the session's
 * kaunta_admin / kaunta_super). On the server, the screens' platform is read
 * back after each change (setLivePlatform).
 *
 * Counter phones check owners' passwords and managers' PINs offline, so the
 * app sends the server the same PBKDF2 hash the demo keeps (src/domain/pin.ts);
 * the server keeps its own bcrypt hash for sign-in.
 */

let server: AdminServer | null = null;

/** The server the screens are signed in to (null: the demo). */
export function setPlatformServer(next: AdminServer | null): void {
  server = next;
  if (!next) demo.setLivePlatform(null);
}

export const isServer = (): boolean => server !== null;

/** Reads the platform from the server again (no-op in the demo). */
export async function refreshPlatform(): Promise<void> {
  if (server) demo.setLivePlatform(await server.platform());
}

async function then<T>(answer: Promise<T>): Promise<T> {
  const result = await answer;
  await refreshPlatform();
  return result;
}

type Created = { account: Account; bar: PlatformBar };

export async function createOwner(
  input: NewPerson & { password: string; barName: string; barCode?: string; maxBars?: number | null },
): Promise<Created | { error: AccountProblem | 'barName' | 'barLimit' | CodeProblem }> {
  if (!server) return demo.createOwner(input);
  return then(
    server.call<Created | { error: AccountProblem | 'barName' | 'barLimit' | CodeProblem }>('super_create_owner', {
      name: input.name, username: input.username, password: input.password, counter_hash: await hashSecret(input.password || '-'),
      bar_name: input.barName, bar_code: input.barCode ?? null, ...(input.maxBars === undefined ? {} : { max_bars: input.maxBars }),
    }),
  );
}

/** Kaunta adds a manager to one bar. */
export async function addManager(barId: string, input: NewPerson & { pin: string }): Promise<{ account: Account } | { error: AccountProblem }> {
  if (!server) {
    const result = await demo.addManager(barId, input);
    if (!('error' in result)) {
      const { ensureMemberPeople } = await import('../admin/bars');
      await ensureMemberPeople(demoStore(barId), barId);
    }
    return result;
  }
  return then(server.call('super_add_manager', { bar_id: barId, ...input, counter_hash: await hashSecret(input.pin || '-') }));
}

/** Kaunta sets an owner's password or a manager's PIN (also unlocks the account). */
export async function resetSecret(accountId: string, secret: string): Promise<'invalid' | null> {
  if (!server) {
    const problem = await demo.resetSecret(accountId, secret);
    if (!problem) await syncAccountPeople(accountId);
    return problem;
  }
  const answer = await then(server.call<{ ok?: true; error?: string }>('super_reset_secret', { account_id: accountId, secret, counter_hash: await hashSecret(secret || '-') }));
  return answer.error ? 'invalid' : null;
}

export async function setBarLimit(accountId: string, max: number | null): Promise<'invalid' | null> {
  if (!server) return demo.setBarLimit(accountId, max);
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > demo.MAX_BAR_LIMIT)) return 'invalid';
  const answer = await then(server.call<{ error?: string }>('super_set_bar_limit', { account_id: accountId, max }));
  return answer.error ? 'invalid' : null;
}

export async function setBarSuspended(barId: string, suspended: boolean): Promise<void> {
  if (!server) return demo.setBarSuspended(barId, suspended);
  await then(server.call('super_set_bar_suspended', { bar_id: barId, suspended }));
}

export type ResetProblem = 'confirm' | 'not_found';

/**
 * Kaunta resets a bar to new: every record of it goes (sales, menu, stock,
 * shifts, approvals, the audit log, phones) and so does everyone the owner
 * added. The bar, its code and its owner stay; it opens in first run.
 * `confirm` is the bar's name, typed.
 */
export async function resetBar(barId: string, confirm: string): Promise<ResetProblem | null> {
  if (!server) {
    const bar = demo.platform().bars.find((b) => b.id === barId);
    if (!bar) return 'not_found';
    if (confirm.trim().toLowerCase() !== bar.name.trim().toLowerCase()) return 'confirm';
    demo.resetBarMembers(barId);
    // Its store on this browser goes; it is made again, new, when the bar is next opened.
    // (The sample bar's store comes back as the sample night: it is the demo.)
    const store = demoStore(barId);
    store.close();
    await store.delete();
    if (barId === demo.SAMPLE_BAR_ID) {
      // The sample counter's store is the app's default one: emptied (it seeds again), not deleted.
      const { db: counterDb } = await import('../data/db');
      await counterDb.transaction('rw', counterDb.tables, async () => {
        for (const table of counterDb.tables) await table.clear();
      });
    }
    refreshSnapshots();
    return null;
  }
  const answer = await then(server.call<{ ok?: true; error?: ResetProblem }>('super_reset_bar', { bar_id: barId, confirm }));
  refreshSnapshots();
  return answer.error ?? null;
}

/** A bar's code: the one given (checked unique), or a fresh one. */
export async function setBarCode(barId: string, code: string): Promise<{ code: string } | { error: CodeProblem }> {
  if (!server) {
    const result = demo.setBarCode(barId, code);
    if ('code' in result && barId !== demo.SAMPLE_BAR_ID) await demoStore(barId).bar.update(barId, { counter_code: result.code });
    return result;
  }
  return then(server.forBar(barId).changeBarCode(code));
}

export async function changeSuperPassword(current: string, next: string): Promise<PasswordProblem | null> {
  if (!server) return demo.changeSuperPassword(current, next);
  const answer = await server.call<{ ok?: true; error?: PasswordProblem }>('super_change_password', { current, next });
  return answer.error ?? null;
}

/** Kaunta records a change in a bar (a staff PIN, a suspension) as Kaunta. */
export async function kauntaRecord(barId: string, event: AdminEvent): Promise<void> {
  if (!server) {
    await recordAdminEvent(demoStore(barId), { person_id: KAUNTA_ACTOR }, event);
    return;
  }
  const result = await server.forBar(barId).push([{ id: uuidv7(), type: event.type, payload: event.payload, created_at: new Date().toISOString() }]);
  const refused = result.results.find((r) => r.status !== 'applied');
  refreshSnapshots();
  if (refused) throw new Error(refused.reason ?? 'refused');
}

// ------------------------------------------------- owners and their managers

/** A new manager for one or more of the owner's bars. `open` is the open bar's store (demo: it gets the row at once). */
export async function createManager(
  owner: Account,
  barIds: string[],
  input: NewPerson & { pin: string },
  open?: KauntaDB,
  openBarId?: string,
): Promise<{ account: Account } | { error: AccountProblem | 'bars' | 'notOwner' }> {
  if (!server) {
    const result = await demo.createManager(owner.id, barIds, input);
    if ('error' in result) return result;
    for (const id of barIds) await managerAdded(owner, result.account, id, id === openBarId ? open : undefined);
    return result;
  }
  return then(server.createManager(barIds, input, await hashSecret(input.pin || '-')) as Promise<{ account: Account } | { error: AccountProblem | 'bars' | 'notOwner' }>);
}

export async function addManagerToBar(owner: Account, manager: Account, barId: string, open?: KauntaDB): Promise<ManagerProblem | null> {
  if (!server) {
    const problem = demo.addManagerToBar(owner.id, manager.id, barId);
    if (!problem) await managerAdded(owner, manager, barId, open);
    return problem;
  }
  const answer = await then(server.addManager(manager.id, barId));
  return 'error' in answer ? (answer.error as ManagerProblem) : null;
}

export async function removeManagerFromBar(owner: Account, manager: Account, barId: string, open?: KauntaDB): Promise<ManagerProblem | null> {
  if (!server) {
    const problem = demo.removeManagerFromBar(owner.id, manager.id, barId);
    if (!problem) await managerRemoved(owner, manager, barId, open);
    return problem;
  }
  const answer = await then(server.removeManager(manager.id, barId));
  return 'error' in answer ? (answer.error as ManagerProblem) : null;
}
