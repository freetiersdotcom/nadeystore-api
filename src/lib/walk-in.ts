// Counter sales need no email. They are recorded on one shared customer under a reserved address, and nothing
// is ever sent to it: ".invalid" is a TLD that can never exist (RFC 2606), so it is also a safe marker.
export const WALK_IN_EMAIL = 'walk-in@counter.invalid';
export const isUndeliverable = (email: string | null | undefined) => !!email && email.trim().toLowerCase().endsWith('.invalid');
export const isWalkIn = (email: string | null | undefined) => (email ?? '').toLowerCase() === WALK_IN_EMAIL;
