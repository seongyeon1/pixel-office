import { useEffect, useState } from 'react';
// Choreography and duty rosters move on this clock; polling alone would freeze idle offices.
const TICK = 5000;
export function useClock() {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), TICK);
    return () => clearInterval(timer);
  }, []);
  return clock;
}
