/**
 * Versioned manager-extension contract that IDACC expects from id-agents.
 *
 * This mirrors id-agents/src/control-center/manifest.ts so the downloaded app can
 * distinguish a fully compatible manager from a stock/stale one before exposing
 * controls that rely on Control Center-only routes.
 */

export const CONTROL_CENTER_API_VERSION = 1;

export interface ControlCenterRoute {
  method: string;
  path: string;
  group: string;
}

export const CONTROL_CENTER_REQUIRED_ROUTES: ControlCenterRoute[] = [
  { method: 'GET', path: '/capabilities', group: 'core' },
  { method: 'GET', path: '/activity', group: 'observability' },
  { method: 'POST', path: '/activity/record', group: 'observability' },
  { method: 'GET', path: '/usage', group: 'observability' },
  { method: 'POST', path: '/usage/record', group: 'observability' },
  { method: 'GET', path: '/usage/by-task', group: 'observability' },
  { method: 'GET', path: '/agents/:id/instructions', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/instructions', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/runtime', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/mcp', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/delegates', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/team', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/metadata', group: 'agent-config' },
  { method: 'GET', path: '/teams/:name/config', group: 'team-config' },
  { method: 'POST', path: '/teams/:name/delegates', group: 'team-config' },
  { method: 'GET', path: '/library/plugins', group: 'library' },
  { method: 'POST', path: '/library/skills/install', group: 'library' },
];

export const CONTROL_CENTER_REQUIRED_FEATURES = [
  'observability',
  'agent-config',
  'team-config',
  'library',
  'brain-context',
  'stalled-sweep',
];

export function controlCenterRouteKey(route: Pick<ControlCenterRoute, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}
