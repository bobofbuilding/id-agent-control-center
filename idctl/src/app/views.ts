/** The canonical list of views — drives the nav bar and number-key routing. */

export type ViewId =
  | 'dash'
  | 'chat'
  | 'inbox'
  | 'tasks'
  | 'health'
  | 'onchain'
  | 'sched'
  | 'config'
  | 'all'
  | 'settings';

export interface ViewDef {
  id: ViewId;
  label: string;
  /** Compact label for the (now 10-wide) nav bar. */
  short: string;
}

export const VIEWS: ViewDef[] = [
  { id: 'dash', label: 'Dashboard', short: 'Dash' },
  { id: 'chat', label: 'Chat', short: 'Chat' },
  { id: 'inbox', label: 'Inbox', short: 'Inbox' },
  { id: 'tasks', label: 'Tasks', short: 'Tasks' },
  { id: 'health', label: 'Health', short: 'Health' },
  { id: 'onchain', label: 'Identity & Keys', short: 'Keys' },
  { id: 'sched', label: 'Schedule', short: 'Sched' },
  { id: 'config', label: 'Config', short: 'Config' },
  { id: 'all', label: 'All Teams', short: 'Teams' },
  { id: 'settings', label: 'Settings', short: 'Settings' },
];

export function viewAtIndex(i: number): ViewId | undefined {
  return VIEWS[i]?.id;
}
