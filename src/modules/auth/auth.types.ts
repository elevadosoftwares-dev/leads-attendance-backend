export const ROLES = ['EMPLOYEE', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Roles an admin screen can hand out. SUPER_ADMIN is only ever created by `npm run seed`. */
export const ASSIGNABLE_ROLES = ['EMPLOYEE', 'ADMIN'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** ADMIN and SUPER_ADMIN: everything an admin may do, the super admin may do too. */
export const ADMIN_ROLES: readonly Role[] = ['ADMIN', 'SUPER_ADMIN'];
export const isAdminRole = (role: Role): boolean => ADMIN_ROLES.includes(role);

export interface AuthUser {
  id: number;
  role: Role;
}
