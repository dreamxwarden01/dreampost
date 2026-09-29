export type WorkspaceView = 'inbox' | 'addresses' | 'reading' | 'postmaster';
export const workspacePaths: Record<WorkspaceView, string> = {
  inbox: '/', addresses: '/settings/addresses', reading: '/settings/reading', postmaster: '/postmaster',
};
export function workspaceView(path: string): WorkspaceView {
  return (Object.entries(workspacePaths).find(([, value]) => value === path.replace(/\/$/, '') || value === path)?.[0] as WorkspaceView | undefined) ?? 'inbox';
}
