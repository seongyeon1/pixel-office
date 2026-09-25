import { useEffect, useRef } from 'react';
import type { Provider, TeamConfig } from '../../shared/contracts';
import type { AgentState } from '../state';
import { drawOffice, positions, targetFor } from './draw';
export function Office({
  agents,
  selected,
  onSelect,
  team,
  external = false,
}: {
  agents: Record<Provider, AgentState>;
  selected: Provider;
  onSelect: (id: Provider) => void;
  team: TeamConfig;
  external?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef({ agents, selected, team, external });
  data.current = { agents, selected, team, external };
  const locations = useRef({ claude: { ...positions.claude }, codex: { ...positions.codex } });
  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    let raf = 0,
      prev = 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const render = (time: number) => {
      const dt = Math.min((time - prev) / 1000, 0.05);
      prev = time;
      const current = data.current;
      for (const id of ['claude', 'codex'] as const) {
        const target = targetFor(id, current.agents[id].activity);
        const p = locations.current[id];
        const dx = target.x - p.x,
          dy = target.y - p.y;
        const distance = Math.hypot(dx, dy);
        if (reduced.matches || distance < 2) {
          p.x = target.x;
          p.y = target.y;
        } else {
          const step = Math.min(110 * dt, distance);
          p.x += (dx / distance) * step;
          p.y += (dy / distance) * step;
        }
      }
      if (document.visibilityState !== 'hidden')
        drawOffice(
          ctx,
          {
            claude: { ...locations.current.claude, ...current.agents.claude },
            codex: { ...locations.current.codex, ...current.agents.codex },
          },
          current.selected,
          current.team,
          time,
          reduced.matches,
          current.external,
        );
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <canvas
      ref={canvas}
      width={960}
      height={620}
      role="img"
      aria-label="Claude와 Codex가 일하는 픽셀 사무실. 아래 에이전트 버튼으로 선택할 수 있습니다."
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) * 960) / rect.width,
          y = ((e.clientY - rect.top) * 620) / rect.height;
        for (const id of ['claude', 'codex'] as const) {
          const p = locations.current[id];
          if (Math.abs(x - p.x) < 55 && y > p.y - 60 && y < p.y + 72) onSelect(id);
        }
      }}
    />
  );
}
