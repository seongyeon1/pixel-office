import { memo } from 'react';
import type { Provider } from '../../shared/contracts';
import { workerSprite, SPRITE_WIDTH, SPRITE_HEIGHT } from './workerSprite';
export const PixelWorker = memo(function PixelWorker({
  provider,
  identity,
}: {
  provider: Provider;
  identity?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${SPRITE_WIDTH} ${SPRITE_HEIGHT}`}
      aria-hidden="true"
      className={`pixel-worker ${provider}`}
      shapeRendering="crispEdges"
    >
      {workerSprite(provider, identity).map(([x, y, width, fill], i) => (
        <rect key={i} x={x} y={y} width={width} height={1} fill={fill} />
      ))}
    </svg>
  );
});
