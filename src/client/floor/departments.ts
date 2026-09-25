import type { Department } from '../../shared/contracts';
export const OTHER = 'other';
const inside = (folder: string, path: string) =>
  path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
// The deepest department folder that contains the room; rooms outside every folder are "기타".
export function departmentOf(root: string, departments: Department[]): string {
  return (
    departments.filter((d) => inside(d.root, root)).sort((a, b) => b.root.length - a.root.length)[0]
      ?.id ?? OTHER
  );
}
// Rooms in department order (as listed), then the rest; stable by root inside a department.
export function byDepartment<T extends { root: string }>(rooms: T[], departments: Department[]) {
  const order = new Map([
    ...departments.map((d, i) => [d.id, i] as const),
    [OTHER, departments.length],
  ]);
  return [...rooms].sort(
    (a, b) =>
      order.get(departmentOf(a.root, departments))! -
        order.get(departmentOf(b.root, departments))! || a.root.localeCompare(b.root),
  );
}
