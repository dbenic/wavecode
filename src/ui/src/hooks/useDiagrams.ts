import { useEffect, type DependencyList, type RefObject } from 'react';
import { renderDiagramsIn } from '../utils/diagrams';

/** After each render of the container, turn its diagram blocks into SVG (see utils/diagrams.ts). */
export function useDiagrams(ref: RefObject<HTMLElement | null>, deps: DependencyList): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    void renderDiagramsIn(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
