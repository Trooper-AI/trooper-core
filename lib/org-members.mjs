import path from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';

/**
 * Org membership synced from the Trooper control plane so the bridge can
 * authorize direct browser connections (Firebase identity → org member).
 *
 * The control plane pushes the full member list (bridge-token-auth'd
 * POST /org/members) on every membership mutation, at provisioning finalize,
 * and periodically via the fleet heartbeat. FAIL-CLOSED: until a list has
 * been synced, no Firebase-token client is considered a member.
 */

export const DEFAULT_ORG_MEMBERS_PATH = '/opt/openclaw-data/org-members.json';

export function orgMembersPath(env = process.env) {
  return env.TROOPER_ORG_MEMBERS_PATH
    || (existsSync('/opt/openclaw-data')
      ? DEFAULT_ORG_MEMBERS_PATH
      : path.resolve('data/org-members.json'));
}

let cache = null;
let cachePath = null;

function normalizeMembers(rawMembers) {
  if (!Array.isArray(rawMembers)) return [];
  return rawMembers
    .filter((member) => member && typeof member === 'object' && member.uid)
    .map((member) => ({
      uid: String(member.uid),
      role: String(member.role || 'member'),
      email: member.email ? String(member.email) : null,
    }));
}

export function readOrgMembers(statePath = orgMembersPath()) {
  if (cache && cachePath === statePath) return cache;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    cache = {
      orgId: parsed?.orgId ? String(parsed.orgId) : null,
      revision: Number(parsed?.revision) || 0,
      updatedAt: parsed?.updatedAt || null,
      members: normalizeMembers(parsed?.members),
    };
  } catch {
    cache = null;
  }
  cachePath = statePath;
  return cache;
}

/**
 * Replace the member list. Stale revisions are ignored so an out-of-order
 * heartbeat push can never roll back a newer membership change.
 * @returns {{ ok: boolean, ignored?: boolean, revision: number, count: number }}
 */
export function writeOrgMembers({ orgId = null, members = [], revision = 0 } = {}, statePath = orgMembersPath()) {
  const current = readOrgMembers(statePath);
  const nextRevision = Number(revision) || 0;
  if (current && nextRevision > 0 && nextRevision < current.revision) {
    return { ok: true, ignored: true, revision: current.revision, count: current.members.length };
  }
  const state = {
    orgId: orgId ? String(orgId) : current?.orgId || null,
    revision: nextRevision || (current?.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
    members: normalizeMembers(members),
  };
  const directory = path.dirname(statePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, statePath);
  cache = state;
  cachePath = statePath;
  return { ok: true, revision: state.revision, count: state.members.length };
}

/** True only when a synced list exists AND contains the uid (fail-closed). */
export function isOrgMember(uid, statePath = orgMembersPath()) {
  const state = readOrgMembers(statePath);
  if (!state || !uid) return false;
  return state.members.some((member) => member.uid === String(uid));
}

export function orgMemberRole(uid, statePath = orgMembersPath()) {
  const state = readOrgMembers(statePath);
  return state?.members.find((member) => member.uid === String(uid))?.role || null;
}

/** Test hook. */
export function __resetOrgMembersCache() {
  cache = null;
  cachePath = null;
}
