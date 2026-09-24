import { createContext, useContext } from 'react';
import type { Citation } from '@editais/shared';

export type CitationSelection = { messageId: string; citation: Citation };

export type CitationContextValue = {
  selected: CitationSelection | null;
  select: (sel: CitationSelection) => void;
};

export const CitationContext = createContext<CitationContextValue>({ selected: null, select: () => {} });

export function useCitationContext(): CitationContextValue {
  return useContext(CitationContext);
}
