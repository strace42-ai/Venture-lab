import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Shared by jsdom UI tests and node-environment server integration tests.
if (typeof window !== 'undefined') {
  afterEach(() => cleanup());
  // jsdom lacks scrollTo
  window.scrollTo = (() => {}) as typeof window.scrollTo;
}
