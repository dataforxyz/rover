import colors, { type StyleFunction } from 'ansi-colors';

/**
 * Format task status for user-friendly display.
 * When a pauseReason is given for PAUSED status, includes it for context (e.g., "Paused (rate limit)").
 */
export const formatTaskStatus = (
  status: string,
  pauseReason?: string
): string => {
  switch (status.toUpperCase()) {
    case 'NEW':
      return 'New';
    case 'IN_PROGRESS':
      return 'In Progress';
    case 'COMPLETED':
      return 'Completed';
    case 'RUNNING':
      return 'Running';
    case 'FAILED':
      return 'Failed';
    case 'ITERATING':
      return 'Iterating';
    case 'MERGED':
      return 'Merged';
    case 'PUSHED':
      return 'Pushed';
    case 'PAUSED':
      return pauseReason ? `Paused (${pauseReason})` : 'Paused';
    default:
      return status;
  }
};

export const statusColor = (status: string): StyleFunction => {
  switch (status.toUpperCase()) {
    case 'NEW':
      return colors.cyan;
    case 'IN_PROGRESS':
      return colors.yellow;
    case 'COMPLETED':
      return colors.green;
    case 'RUNNING':
      return colors.cyan;
    case 'ITERATING':
      return colors.magenta;
    case 'FAILED':
      return colors.red;
    case 'MERGED':
      return colors.green;
    case 'PUSHED':
      return colors.green;
    case 'PAUSED':
      return colors.yellow;
    default:
      return colors.gray;
  }
};
