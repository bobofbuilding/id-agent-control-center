export type AgentStatusClass = 'ok' | 'warn' | 'err';

export function statusClass(status?: string): AgentStatusClass {
  if (/running|online|ok/i.test(status ?? '')) return 'ok';
  if (/start|pending|processing/i.test(status ?? '')) return 'warn';
  return 'err';
}

export function isAgentLive(status?: string): boolean {
  return statusClass(status) === 'ok';
}
