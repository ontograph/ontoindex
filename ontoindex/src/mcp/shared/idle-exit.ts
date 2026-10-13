export function resolveIdleExitMs(raw?: string): number | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;

  const idleMs = Number(value);
  return Number.isSafeInteger(idleMs) && idleMs >= 60_000 && idleMs <= 86_400_000 ? idleMs : null;
}

export interface IdleTrackerOptions {
  idleMs: number;
  now?: () => number;
  onIdle: () => void;
}

export function createIdleTracker({ idleMs, now = Date.now, onIdle }: IdleTrackerOptions) {
  let lastActivity = now();
  let inFlight = 0;
  let fired = false;

  return {
    touch() {
      if (!fired) lastActivity = now();
    },
    begin() {
      if (fired) return;
      inFlight += 1;
      lastActivity = now();
    },
    end() {
      if (fired) return;
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) lastActivity = now();
    },
    check() {
      if (fired || inFlight > 0 || now() - lastActivity < idleMs) return false;
      fired = true;
      onIdle();
      return true;
    },
  };
}
