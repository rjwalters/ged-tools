export const decideWrite = ({ exists = false, bytesMatch = false, force = false } = {}) => {
  if (!exists) return 'write';
  if (bytesMatch) return 'skip-unchanged';
  return force ? 'overwrite' : 'refuse';
};

export const decideWritePair = ({ parts = [], force = false } = {}) =>
  decideWrite({
    exists: parts.some((p) => p.exists),
    bytesMatch: parts.length > 0 && parts.every((p) => p.exists && p.bytesMatch),
    force,
  });

export const exitCodeForWrite = (decision) => (decision === 'refuse' ? 3 : 0);
