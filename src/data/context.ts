import { createContext, useContext } from 'react';
import type { DemoDataset } from '../domain/types';
import { demoData } from './demo';

export const DataContext = createContext<DemoDataset>(demoData);

export function useData(): DemoDataset {
  return useContext(DataContext);
}
