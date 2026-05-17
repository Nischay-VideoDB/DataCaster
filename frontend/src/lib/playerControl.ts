type SeekFn = (seconds: number) => boolean;

let registered: SeekFn | null = null;

/** StreamPanel registers its seeker on mount; unregisters on unmount. */
export function registerPlayerSeeker(fn: SeekFn | null): void {
  registered = fn;
}

/** EventTimeline (and others) call this to seek the active player.
 *  Returns true if a player was registered and the seek was attempted. */
export function seekPlayer(seconds: number): boolean {
  if (!registered) return false;
  return registered(seconds);
}
