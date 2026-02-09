import { describe, it, expect } from 'vitest';
import {
  parseAgentError,
  RateLimitError,
  AuthenticationError,
} from '../errors.js';

describe('parseAgentError', () => {
  describe('credit/usage limit detection', () => {
    it('should classify "hit your limit" as RateLimitError', () => {
      const error = parseAgentError(
        "You've hit your limit · resets 2pm",
        '',
        1,
        'claude'
      );
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.isRetryable).toBe(true);
    });

    it('should classify "usage limit" as RateLimitError', () => {
      const error = parseAgentError(
        'You have reached your usage limit for this billing period',
        '',
        1,
        'claude'
      );
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.isRetryable).toBe(true);
    });

    it('should classify "plan limit" as RateLimitError', () => {
      const error = parseAgentError(
        'You have reached your plan limit',
        '',
        1,
        'claude'
      );
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.isRetryable).toBe(true);
    });
  });

  describe('auth error with credit/billing keywords → RateLimitError', () => {
    it('should classify auth error with "insufficient credit balance" as RateLimitError', () => {
      const jsonError = JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'Your account has insufficient credit balance',
        },
      });
      const error = parseAgentError(jsonError, '', 1, 'claude');
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.isRetryable).toBe(true);
    });

    it('should classify auth error with "billing" as RateLimitError', () => {
      const jsonError = JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'Billing issue: please update your payment method',
        },
      });
      const error = parseAgentError(jsonError, '', 1, 'claude');
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.isRetryable).toBe(true);
    });

    it('should classify auth error with "quota" as RateLimitError', () => {
      const jsonError = JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'API quota exceeded for this account',
        },
      });
      const error = parseAgentError(jsonError, '', 1, 'claude');
      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.isRetryable).toBe(true);
    });
  });

  describe('normal auth errors remain AuthenticationError', () => {
    it('should classify "invalid api key" as AuthenticationError', () => {
      const jsonError = JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'invalid api key',
        },
      });
      const error = parseAgentError(jsonError, '', 1, 'claude');
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.isRetryable).toBe(false);
    });

    it('should classify standard auth error as AuthenticationError', () => {
      const jsonError = JSON.stringify({
        error: {
          type: 'authentication_error',
          message: 'Invalid bearer token',
        },
      });
      const error = parseAgentError(jsonError, '', 1, 'claude');
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.isRetryable).toBe(false);
    });
  });
});
