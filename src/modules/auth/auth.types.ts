export const ROLES = ['EMPLOYEE', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export interface AuthUser {
  id: number;
  role: Role;
}
