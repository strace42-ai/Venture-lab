import type { ReactNode } from 'react';
import type { DemoDataset } from '../domain/types';
import { DataContext } from './context';
import { demoData } from './demo';

/** Single data entry point; later sprints swap the demo fixture for a persistent source. */
export function DataProvider({ data = demoData, children }: { data?: DemoDataset; children: ReactNode }) {
  return <DataContext.Provider value={data}>{children}</DataContext.Provider>;
}
