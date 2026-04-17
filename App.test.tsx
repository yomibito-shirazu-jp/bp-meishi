import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders without crashing', () => {
    // A simple test to verify testing environment is correctly set up
    render(<App />);
    expect(screen.getAllByText(/名刺/)[0]).toBeDefined();
  });
});
