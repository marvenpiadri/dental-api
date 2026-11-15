// Copied from the frontend's src/app/core/auth/auth-rules.ts (the contract). tests/permissions.contract.test.ts fails if the two drift.
// The PIN/Staff parts stay in the frontend; the server authenticates with passwords and sessions instead.
export type Role = 'owner' | 'admin' | 'dentist' | 'assistant' | 'reception' | 'accountant';
export type Area = 'patients' | 'clinical' | 'appointments' | 'billing' | 'reports' | 'practice' | 'tasks' | 'team' | 'settings' | 'profile';
export type Action = 'view' | 'create' | 'edit' | 'approve' | 'void' | 'manage';
export type Permission = `${Area}.${Action}`;

export const ROLES: Role[] = ['owner', 'admin', 'dentist', 'assistant', 'reception', 'accountant'];
export const AREAS: Area[] = ['patients', 'clinical', 'appointments', 'billing', 'reports', 'practice', 'tasks', 'team', 'settings', 'profile'];
export const ACTIONS: Action[] = ['view', 'create', 'edit', 'approve', 'void', 'manage'];

const all = (a: Area, ...x: Action[]): Permission[] => (x.length ? x : ACTIONS).map((y) => `${a}.${y}` as Permission);

/** Role defaults. Clinical data stays with the clinical roles; money stays with billing roles. */
const DEFAULTS: Record<Role, readonly Permission[]> = {
  owner: AREAS.flatMap((a) => all(a)),
  admin: [...all('patients', 'view', 'create', 'edit', 'manage'), ...all('appointments'), ...all('billing', 'view', 'create', 'edit'), ...all('reports', 'view'), ...all('practice'), ...all('tasks'), ...all('team', 'view', 'create', 'edit', 'manage'), ...all('settings', 'view', 'edit', 'manage'), ...all('profile', 'view')],
  dentist: [...all('patients', 'view', 'create', 'edit'), ...all('clinical', 'view', 'create', 'edit', 'approve', 'void'), ...all('appointments', 'view', 'create', 'edit'), ...all('practice', 'view', 'create'), ...all('tasks', 'view', 'create', 'edit')],
  assistant: [...all('patients', 'view'), ...all('clinical', 'view', 'create', 'edit'), ...all('appointments', 'view', 'edit'), ...all('practice', 'view', 'create', 'edit'), ...all('tasks', 'view', 'create', 'edit')],
  reception: [...all('patients', 'view', 'create', 'edit'), ...all('appointments', 'view', 'create', 'edit', 'manage'), ...all('billing', 'view', 'create'), ...all('tasks', 'view', 'create', 'edit')],
  accountant: [...all('patients', 'view'), ...all('billing', 'view', 'create', 'edit', 'approve', 'void'), ...all('reports', 'view'), ...all('practice', 'view'), ...all('tasks', 'view')],
};

/** Clinic identity and ownership are never delegated, whatever the owner ticks. */
export const OWNER_ONLY: readonly Permission[] = ['profile.create', 'profile.edit', 'profile.approve', 'profile.void', 'profile.manage', 'team.approve', 'team.void'];

export const defaultsOf = (role: Role): readonly Permission[] => DEFAULTS[role];

export type Who = { role: Role; extra?: Permission[]; removed?: Permission[] };
export function effective(who: Who): Set<Permission> {
  const out = new Set<Permission>(DEFAULTS[who.role]);
  if (who.role === 'owner') return out;
  for (const p of who.extra ?? []) if (!OWNER_ONLY.includes(p)) out.add(p);
  for (const p of who.removed ?? []) out.delete(p);
  return out;
}

export const can = (who: Who, permission: Permission): boolean => effective(who).has(permission);

/** Turns a wanted set of permissions into the owner's changes to the role's defaults. Owner-only permissions are ignored. */
export function diffFromRole(role: Role, wanted: ReadonlySet<Permission>): { extra: Permission[]; removed: Permission[] } {
  const base = new Set(DEFAULTS[role]);
  const extra = [...wanted].filter((p) => !base.has(p) && !OWNER_ONLY.includes(p));
  const removed = [...base].filter((p) => !wanted.has(p));
  return { extra, removed };
}

/** Owners manage everyone. Others (with team permission) manage only roles below owner, and never themselves into a higher role. */
export const canManageRole = (actor: Who, target: Role): boolean => actor.role === 'owner' || (can(actor, 'team.manage') && target !== 'owner');

