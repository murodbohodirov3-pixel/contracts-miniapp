import { describe, expect, it } from 'vitest';
import { canAccessDepartment, isAdmin, type AuthUser } from './auth.js';

const viewer: AuthUser = { id: 'u1', email: 'viewer@example.test', displayName: 'Viewer', roles: ['viewer'], departmentIds: ['d1'] };
const admin: AuthUser = { ...viewer, roles: ['admin'], departmentIds: [] };

describe('department access', () => {
  it('limits a non-admin user to assigned departments', () => {
    expect(canAccessDepartment(viewer, 'd1')).toBe(true);
    expect(canAccessDepartment(viewer, 'd2')).toBe(false);
  });

  it('grants global access only to admins', () => {
    expect(isAdmin(viewer)).toBe(false);
    expect(canAccessDepartment(admin, 'd2')).toBe(true);
  });
});
