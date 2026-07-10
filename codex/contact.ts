import type { SessionInfo } from "../types.ts";

export interface IntercomContact {
  target: string;
  id: string;
  name?: string;
  duplicateName: boolean;
  fallback?: boolean;
}

function duplicateSessionNames(sessions: SessionInfo[]): Set<string> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const name = session.name?.trim().toLowerCase();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

export function chooseContactTarget(currentSession: SessionInfo, sessions: SessionInfo[]): IntercomContact {
  const duplicates = duplicateSessionNames(sessions);
  const name = currentSession.name?.trim() || undefined;
  const duplicateName = Boolean(name && duplicates.has(name.toLowerCase()));
  return {
    target: name && !duplicateName ? name : currentSession.id,
    id: currentSession.id,
    ...(name ? { name } : {}),
    duplicateName,
  };
}

export function formatContactInstruction(contact: Pick<IntercomContact, "target">): string {
  return `Intercom send ID: ${contact.target}`;
}

export async function resolveContactTarget(
  id: string,
  name: string | undefined,
  listSessions: () => Promise<SessionInfo[]>,
): Promise<IntercomContact> {
  try {
    const sessions = await listSessions();
    const currentSession = sessions.find((session) => session.id === id);
    if (currentSession) return chooseContactTarget(currentSession, sessions);
  } catch {
    // The stable ID remains usable when discovery is temporarily unavailable.
  }
  return { target: id, id, ...(name ? { name } : {}), duplicateName: false, fallback: true };
}
